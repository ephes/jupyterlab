// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ISessionContext, WidgetTracker } from '@jupyterlab/apputils';
import * as nbformat from '@jupyterlab/nbformat';
import { IOutputModel, IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { IRenderMime } from '@jupyterlab/rendermime-interfaces';
import { Kernel, KernelMessage } from '@jupyterlab/services';
import {
  JSONObject,
  PromiseDelegate,
  ReadonlyJSONObject,
  ReadonlyPartialJSONObject,
  UUID
} from '@lumino/coreutils';
import { Message } from '@lumino/messaging';
import { AttachedProperty } from '@lumino/properties';
import { Signal } from '@lumino/signaling';
import { Panel, PanelLayout, Widget } from '@lumino/widgets';
import { IOutputAreaModel } from './model';

/**
 * The class name added to an output area widget.
 */
const OUTPUT_AREA_CLASS = 'jp-OutputArea';

/**
 * The class name added to the direction children of OutputArea
 */
const OUTPUT_AREA_ITEM_CLASS = 'jp-OutputArea-child';

/**
 * The class name added to actual outputs
 */
const OUTPUT_AREA_OUTPUT_CLASS = 'jp-OutputArea-output';

/**
 * The class name added to prompt children of OutputArea.
 */
const OUTPUT_AREA_PROMPT_CLASS = 'jp-OutputArea-prompt';

/**
 * The class name added to OutputPrompt.
 */
const OUTPUT_PROMPT_CLASS = 'jp-OutputPrompt';

/**
 * The class name added to an execution result.
 */
const EXECUTE_CLASS = 'jp-OutputArea-executeResult';

/**
 * The class name added stdin items of OutputArea
 */
const OUTPUT_AREA_STDIN_ITEM_CLASS = 'jp-OutputArea-stdin-item';

/**
 * The class name added to stdin widgets.
 */
const STDIN_CLASS = 'jp-Stdin';

/**
 * The class name added to stdin data prompt nodes.
 */
const STDIN_PROMPT_CLASS = 'jp-Stdin-prompt';

/**
 * The class name added to stdin data input nodes.
 */
const STDIN_INPUT_CLASS = 'jp-Stdin-input';

/** ****************************************************************************
 * OutputArea
 ******************************************************************************/

/**
 * An output area widget.
 *
 * #### Notes
 * The widget model must be set separately and can be changed
 * at any time.  Consumers of the widget must account for a
 * `null` model, and may want to listen to the `modelChanged`
 * signal.
 */
export class OutputArea extends Widget {
  /**
   * Construct an output area widget.
   */
  constructor(options: OutputArea.IOptions) {
    super();
    const model = (this.model = options.model);
    this.addClass(OUTPUT_AREA_CLASS);
    this.rendermime = options.rendermime;
    this.contentFactory =
      options.contentFactory || OutputArea.defaultContentFactory;
    this.layout = new PanelLayout();
    this._maxNumberOutputs = options.maxNumberOutputs ?? Infinity;

    for (
      let i = 0;
      i < Math.min(model.length, this._maxNumberOutputs + 1);
      i++
    ) {
      const output = model.get(i);
      this._insertOutput(i, output);
    }
    model.changed.connect(this.onModelChanged, this);
    model.stateChanged.connect(this.onStateChanged, this);
  }

  /**
   * The model used by the widget.
   */
  readonly model: IOutputAreaModel;

  /**
   * The content factory used by the widget.
   */
  readonly contentFactory: OutputArea.IContentFactory;

  /**
   * The rendermime instance used by the widget.
   */
  readonly rendermime: IRenderMimeRegistry;

  /**
   * A read-only sequence of the children widgets in the output area.
   */
  get widgets(): ReadonlyArray<Widget> {
    return (this.layout as PanelLayout).widgets;
  }

  /**
   * A public signal used to indicate the number of displayed outputs has changed.
   *
   * #### Notes
   * This is useful for parents who want to apply styling based on the number
   * of outputs. Emits the current number of outputs.
   */
  readonly outputLengthChanged = new Signal<this, number>(this);

  /**
   * The kernel future associated with the output area.
   */
  get future(): Kernel.IShellFuture<
    KernelMessage.IExecuteRequestMsg,
    KernelMessage.IExecuteReplyMsg
  > {
    return this._future;
  }

  set future(
    value: Kernel.IShellFuture<
      KernelMessage.IExecuteRequestMsg,
      KernelMessage.IExecuteReplyMsg
    >
  ) {
    // Bail if the model is disposed.
    if (this.model.isDisposed) {
      throw Error('Model is disposed');
    }
    if (this._future === value) {
      return;
    }
    if (this._future) {
      this._future.dispose();
    }
    this._future = value;

    this.model.clear();

    // Make sure there were no input widgets.
    if (this.widgets.length) {
      this._clear();
      this.outputLengthChanged.emit(
        Math.min(this.model.length, this._maxNumberOutputs)
      );
    }

    // Handle published messages.
    value.onIOPub = this._onIOPub;

    // Handle the execute reply.
    value.onReply = this._onExecuteReply;

    // Handle stdin.
    value.onStdin = msg => {
      if (KernelMessage.isInputRequestMsg(msg)) {
        this.onInputRequest(msg, value);
      }
    };
  }

  /**
   * The maximum number of output items to display on top and bottom of cell output.
   *
   * ### Notes
   * It is set to Infinity if no trim is applied.
   */
  get maxNumberOutputs(): number {
    return this._maxNumberOutputs;
  }
  set maxNumberOutputs(limit: number) {
    if (limit <= 0) {
      console.warn(`OutputArea.maxNumberOutputs must be strictly positive.`);
      return;
    }
    const lastShown = this._maxNumberOutputs;
    this._maxNumberOutputs = limit;
    if (lastShown < limit) {
      this._showTrimmedOutputs(lastShown);
    }
  }

  /**
   * Dispose of the resources used by the output area.
   */
  dispose(): void {
    if (this._future) {
      this._future.dispose();
      this._future = null!;
    }
    this._displayIdMap.clear();
    this._outputTracker.dispose();
    super.dispose();
  }

  /**
   * Follow changes on the model state.
   */
  protected onModelChanged(
    sender: IOutputAreaModel,
    args: IOutputAreaModel.ChangedArgs
  ): void {
    switch (args.type) {
      case 'add':
        this._insertOutput(args.newIndex, args.newValues[0]);
        break;
      case 'remove':
        if (this.widgets.length) {
          // all items removed from model
          if (this.model.length === 0) {
            this._clear();
          } else {
            // range of items removed from model
            // remove widgets corresponding to removed model items
            const startIndex = args.oldIndex;
            for (
              let i = 0;
              i < args.oldValues.length && startIndex < this.widgets.length;
              ++i
            ) {
              const widget = this.widgets[startIndex];
              widget.parent = null;
              widget.dispose();
            }

            // apply item offset to target model item indices in _displayIdMap
            this._moveDisplayIdIndices(startIndex, args.oldValues.length);

            // prevent jitter caused by immediate height change
            this._preventHeightChangeJitter();
          }
        }
        break;
      case 'set':
        this._setOutput(args.newIndex, args.newValues[0]);
        break;
      default:
        break;
    }
    this.outputLengthChanged.emit(
      Math.min(this.model.length, this._maxNumberOutputs)
    );
  }

  /**
   * Update indices in _displayIdMap in response to element remove from model items
   *
   * @param startIndex - The index of first element removed
   *
   * @param count - The number of elements removed from model items
   *
   */
  private _moveDisplayIdIndices(startIndex: number, count: number) {
    this._displayIdMap.forEach((indices: number[]) => {
      const rangeEnd = startIndex + count;
      const numIndices = indices.length;
      // reverse loop in order to prevent removing element affecting the index
      for (let i = numIndices - 1; i >= 0; --i) {
        const index = indices[i];
        // remove model item indices in removed range
        if (index >= startIndex && index < rangeEnd) {
          indices.splice(i, 1);
        } else if (index >= rangeEnd) {
          // move model item indices that were larger than range end
          indices[i] -= count;
        }
      }
    });
  }

  /**
   * Follow changes on the output model state.
   */
  protected onStateChanged(
    sender: IOutputAreaModel,
    change: number | void
  ): void {
    const outputLength = Math.min(this.model.length, this._maxNumberOutputs);
    if (change) {
      if (change >= this._maxNumberOutputs) {
        // Bail early
        return;
      }
      this._setOutput(change, this.model.get(change));
    } else {
      for (let i = 0; i < outputLength; i++) {
        this._setOutput(i, this.model.get(i));
      }
    }
    this.outputLengthChanged.emit(outputLength);
  }

  /**
   * Clear the widget outputs.
   */
  private _clear(): void {
    // Bail if there is no work to do.
    if (!this.widgets.length) {
      return;
    }

    // Remove all of our widgets.
    const length = this.widgets.length;
    for (let i = 0; i < length; i++) {
      const widget = this.widgets[0];
      widget.parent = null;
      widget.dispose();
    }

    // Clear the display id map.
    this._displayIdMap.clear();

    // prevent jitter caused by immediate height change
    this._preventHeightChangeJitter();
  }

  private _preventHeightChangeJitter() {
    // When an output area is cleared and then quickly replaced with new
    // content (as happens with @interact in widgets, for example), the
    // quickly changing height can make the page jitter.
    // We introduce a small delay in the minimum height
    // to prevent this jitter.
    const rect = this.node.getBoundingClientRect();
    this.node.style.minHeight = `${rect.height}px`;
    if (this._minHeightTimeout) {
      window.clearTimeout(this._minHeightTimeout);
    }
    this._minHeightTimeout = window.setTimeout(() => {
      if (this.isDisposed) {
        return;
      }
      this.node.style.minHeight = '';
    }, 50);
  }

  /**
   * Handle an input request from a kernel.
   */
  protected onInputRequest(
    msg: KernelMessage.IInputRequestMsg,
    future: Kernel.IShellFuture
  ): void {
    // Add an output widget to the end.
    const factory = this.contentFactory;
    const stdinPrompt = msg.content.prompt;
    const password = msg.content.password;

    const panel = new Panel();
    panel.addClass(OUTPUT_AREA_ITEM_CLASS);
    panel.addClass(OUTPUT_AREA_STDIN_ITEM_CLASS);

    const prompt = factory.createOutputPrompt();
    prompt.addClass(OUTPUT_AREA_PROMPT_CLASS);
    panel.addWidget(prompt);

    const input = factory.createStdin({
      parent_header: msg.header,
      prompt: stdinPrompt,
      password,
      future
    });
    input.addClass(OUTPUT_AREA_OUTPUT_CLASS);
    panel.addWidget(input);

    const layout = this.layout as PanelLayout;
    layout.addWidget(panel);

    /**
     * Wait for the stdin to complete, add it to the model (so it persists)
     * and remove the stdin widget.
     */
    void input.value.then(value => {
      // Use stdin as the stream so it does not get combined with stdout.
      this.model.add({
        output_type: 'stream',
        name: 'stdin',
        text: value + '\n'
      });
      panel.dispose();
    });
  }

  /**
   * Update an output in the layout in place.
   */
  private _setOutput(index: number, model: IOutputModel): void {
    if (index >= this._maxNumberOutputs) {
      return;
    }

    const layout = this.layout as PanelLayout;
    const panel = layout.widgets[index] as Panel;
    const renderer = (panel.widgets
      ? panel.widgets[1]
      : panel) as IRenderMime.IRenderer;
    // Check whether it is safe to reuse renderer:
    // - Preferred mime type has not changed
    // - Isolation has not changed
    const mimeType = this.rendermime.preferredMimeType(
      model.data,
      model.trusted ? 'any' : 'ensure'
    );
    if (
      Private.currentPreferredMimetype.get(renderer) === mimeType &&
      OutputArea.isIsolated(mimeType, model.metadata) ===
        renderer instanceof Private.IsolatedRenderer
    ) {
      void renderer.renderModel(model);
    } else {
      layout.widgets[index].dispose();
      this._insertOutput(index, model);
    }
  }

  /**
   * Render and insert a single output into the layout.
   *
   * @param index - The index of the output to be inserted.
   * @param model - The model of the output to be inserted.
   */
  private _insertOutput(index: number, model: IOutputModel): void {
    if (index > this._maxNumberOutputs) {
      return;
    }

    const layout = this.layout as PanelLayout;

    if (index === this._maxNumberOutputs) {
      const warning = new Private.TrimmedOutputs(this._maxNumberOutputs, () => {
        const lastShown = this._maxNumberOutputs;
        this._maxNumberOutputs = Infinity;
        this._showTrimmedOutputs(lastShown);
      });
      layout.insertWidget(index, this._wrappedOutput(warning));
    } else {
      let output = this.createOutputItem(model);
      if (output) {
        output.toggleClass(EXECUTE_CLASS, model.executionCount !== null);
      } else {
        output = new Widget();
      }

      if (!this._outputTracker.has(output)) {
        void this._outputTracker.add(output);
      }
      layout.insertWidget(index, output);
    }
  }

  /**
   * A widget tracker for individual output widgets in the output area.
   */
  get outputTracker(): WidgetTracker<Widget> {
    return this._outputTracker;
  }

  /**
   * Dispose information message and show output models from the given
   * index to maxNumberOutputs
   *
   * @param lastShown Starting model index to insert.
   */
  private _showTrimmedOutputs(lastShown: number) {
    // Dispose information widget
    this.widgets[lastShown].dispose();

    for (let idx = lastShown; idx < this.model.length; idx++) {
      this._insertOutput(idx, this.model.get(idx));
    }

    this.outputLengthChanged.emit(
      Math.min(this.model.length, this._maxNumberOutputs)
    );
  }

  /**
   * Create an output item with a prompt and actual output
   *
   * @returns a rendered widget, or null if we cannot render
   * #### Notes
   */
  protected createOutputItem(model: IOutputModel): Widget | null {
    const output = this.createRenderedMimetype(model);

    if (!output) {
      return null;
    }

    return this._wrappedOutput(output, model.executionCount);
  }

  /**
   * Render a mimetype
   */
  protected createRenderedMimetype(model: IOutputModel): Widget | null {
    const mimeType = this.rendermime.preferredMimeType(
      model.data,
      model.trusted ? 'any' : 'ensure'
    );

    if (!mimeType) {
      return null;
    }
    let output = this.rendermime.createRenderer(mimeType);
    const isolated = OutputArea.isIsolated(mimeType, model.metadata);
    if (isolated === true) {
      output = new Private.IsolatedRenderer(output);
    }
    Private.currentPreferredMimetype.set(output, mimeType);
    output.renderModel(model).catch(error => {
      // Manually append error message to output
      const pre = document.createElement('pre');
      pre.textContent = `Javascript Error: ${error.message}`;
      output.node.appendChild(pre);

      // Remove mime-type-specific CSS classes
      output.node.className = 'lm-Widget jp-RenderedText';
      output.node.setAttribute(
        'data-mime-type',
        'application/vnd.jupyter.stderr'
      );
    });
    return output;
  }

  /**
   * Handle an iopub message.
   */
  private _onIOPub = (msg: KernelMessage.IIOPubMessage) => {
    const model = this.model;
    const msgType = msg.header.msg_type;
    let output: nbformat.IOutput;
    const transient = ((msg.content as any).transient || {}) as JSONObject;
    const displayId = transient['display_id'] as string;
    let targets: number[] | undefined;

    switch (msgType) {
      case 'execute_result':
      case 'display_data':
      case 'stream':
      case 'error':
        output = { ...msg.content, output_type: msgType };
        model.add(output);
        break;
      case 'clear_output': {
        const wait = (msg as KernelMessage.IClearOutputMsg).content.wait;
        model.clear(wait);
        break;
      }
      case 'update_display_data':
        output = { ...msg.content, output_type: 'display_data' };
        targets = this._displayIdMap.get(displayId);
        if (targets) {
          for (const index of targets) {
            model.set(index, output);
          }
        }
        break;
      default:
        break;
    }
    if (displayId && msgType === 'display_data') {
      targets = this._displayIdMap.get(displayId) || [];
      targets.push(model.length - 1);
      this._displayIdMap.set(displayId, targets);
    }
  };

  /**
   * Handle an execute reply message.
   */
  private _onExecuteReply = (msg: KernelMessage.IExecuteReplyMsg) => {
    // API responses that contain a pager are special cased and their type
    // is overridden from 'execute_reply' to 'display_data' in order to
    // render output.
    const model = this.model;
    const content = msg.content;
    if (content.status !== 'ok') {
      return;
    }
    const payload = content && content.payload;
    if (!payload || !payload.length) {
      return;
    }
    const pages = payload.filter((i: any) => (i as any).source === 'page');
    if (!pages.length) {
      return;
    }
    const page = JSON.parse(JSON.stringify(pages[0]));
    const output: nbformat.IOutput = {
      output_type: 'display_data',
      data: (page as any).data as nbformat.IMimeBundle,
      metadata: {}
    };
    model.add(output);
  };

  /**
   * Wrap a output widget within a output panel
   *
   * @param output Output widget to wrap
   * @param executionCount Execution count
   * @returns The output panel
   */
  private _wrappedOutput(
    output: Widget,
    executionCount: number | null = null
  ): Panel {
    const panel = new Private.OutputPanel();

    panel.addClass(OUTPUT_AREA_ITEM_CLASS);

    const prompt = this.contentFactory.createOutputPrompt();
    prompt.executionCount = executionCount;
    prompt.addClass(OUTPUT_AREA_PROMPT_CLASS);
    panel.addWidget(prompt);

    output.addClass(OUTPUT_AREA_OUTPUT_CLASS);
    panel.addWidget(output);
    return panel;
  }

  private _minHeightTimeout: number | null = null;
  private _future: Kernel.IShellFuture<
    KernelMessage.IExecuteRequestMsg,
    KernelMessage.IExecuteReplyMsg
  >;
  private _displayIdMap = new Map<string, number[]>();
  private _outputTracker = new WidgetTracker<Widget>({
    namespace: UUID.uuid4()
  });

  /**
   * The maximum outputs to show in the trimmed
   * output area.
   */
  private _maxNumberOutputs: number;
}

export class SimplifiedOutputArea extends OutputArea {
  /**
   * Handle an input request from a kernel by doing nothing.
   */
  protected onInputRequest(
    msg: KernelMessage.IInputRequestMsg,
    future: Kernel.IShellFuture
  ): void {
    return;
  }

  /**
   * Create an output item without a prompt, just the output widgets
   */
  protected createOutputItem(model: IOutputModel): Widget | null {
    const output = this.createRenderedMimetype(model);
    if (output) {
      output.addClass(OUTPUT_AREA_OUTPUT_CLASS);
    }
    return output;
  }
}

/**
 * A namespace for OutputArea statics.
 */
export namespace OutputArea {
  /**
   * The options to create an `OutputArea`.
   */
  export interface IOptions {
    /**
     * The model used by the widget.
     */
    model: IOutputAreaModel;

    /**
     * The content factory used by the widget to create children.
     */
    contentFactory?: IContentFactory;

    /**
     * The rendermime instance used by the widget.
     */
    rendermime: IRenderMimeRegistry;

    /**
     * The maximum number of output items to display on top and bottom of cell output.
     */
    maxNumberOutputs?: number;
  }

  /**
   * Execute code on an output area.
   */
  export async function execute(
    code: string,
    output: OutputArea,
    sessionContext: ISessionContext,
    metadata?: JSONObject
  ): Promise<KernelMessage.IExecuteReplyMsg | undefined> {
    // Override the default for `stop_on_error`.
    let stopOnError = true;
    if (
      metadata &&
      Array.isArray(metadata.tags) &&
      metadata.tags.indexOf('raises-exception') !== -1
    ) {
      stopOnError = false;
    }
    const content: KernelMessage.IExecuteRequestMsg['content'] = {
      code,
      stop_on_error: stopOnError
    };

    const kernel = sessionContext.session?.kernel;
    if (!kernel) {
      throw new Error('Session has no kernel.');
    }
    const future = kernel.requestExecute(content, false, metadata);
    output.future = future;
    return future.done;
  }

  export function isIsolated(
    mimeType: string,
    metadata: ReadonlyPartialJSONObject
  ): boolean {
    const mimeMd = metadata[mimeType] as ReadonlyJSONObject | undefined;
    // mime-specific higher priority
    if (mimeMd && mimeMd['isolated'] !== undefined) {
      return !!mimeMd['isolated'];
    } else {
      // fallback on global
      return !!metadata['isolated'];
    }
  }

  /**
   * An output area widget content factory.
   *
   * The content factory is used to create children in a way
   * that can be customized.
   */
  export interface IContentFactory {
    /**
     * Create an output prompt.
     */
    createOutputPrompt(): IOutputPrompt;

    /**
     * Create an stdin widget.
     */
    createStdin(options: Stdin.IOptions): IStdin;
  }

  /**
   * The default implementation of `IContentFactory`.
   */
  export class ContentFactory implements IContentFactory {
    /**
     * Create the output prompt for the widget.
     */
    createOutputPrompt(): IOutputPrompt {
      return new OutputPrompt();
    }

    /**
     * Create an stdin widget.
     */
    createStdin(options: Stdin.IOptions): IStdin {
      return new Stdin(options);
    }
  }

  /**
   * The default `ContentFactory` instance.
   */
  export const defaultContentFactory = new ContentFactory();
}

/** ****************************************************************************
 * OutputPrompt
 ******************************************************************************/

/**
 * The interface for an output prompt.
 */
export interface IOutputPrompt extends Widget {
  /**
   * The execution count for the prompt.
   */
  executionCount: nbformat.ExecutionCount;
}

/**
 * The default output prompt implementation
 */
export class OutputPrompt extends Widget implements IOutputPrompt {
  /*
   * Create an output prompt widget.
   */
  constructor() {
    super();
    this.addClass(OUTPUT_PROMPT_CLASS);
  }

  /**
   * The execution count for the prompt.
   */
  get executionCount(): nbformat.ExecutionCount {
    return this._executionCount;
  }
  set executionCount(value: nbformat.ExecutionCount) {
    this._executionCount = value;
    if (value === null) {
      this.node.textContent = '';
    } else {
      this.node.textContent = `[${value}]:`;
    }
  }

  private _executionCount: nbformat.ExecutionCount = null;
}

/** ****************************************************************************
 * Stdin
 ******************************************************************************/

/**
 * The stdin interface
 */
export interface IStdin extends Widget {
  /**
   * The stdin value.
   */
  readonly value: Promise<string>;
}

/**
 * The default stdin widget.
 */
export class Stdin extends Widget implements IStdin {
  private static _history: string[] = [];

  private static _historyAt(ix: number): string | undefined {
    const len = Stdin._history.length;
    // interpret negative ix exactly like Array.at
    ix = ix < 0 ? len + ix : ix;

    if (ix < len) {
      return Stdin._history[ix];
    }
    // return undefined if ix is out of bounds
  }

  private static _historyPush(line: string): void {
    Stdin._history.push(line);
    if (Stdin._history.length > 1000) {
      // truncate line history if it's too long
      Stdin._history.shift();
    }
  }

  /**
   * Construct a new input widget.
   */
  constructor(options: Stdin.IOptions) {
    super({
      node: Private.createInputWidgetNode(options.prompt, options.password)
    });
    this.addClass(STDIN_CLASS);
    this._history_ix = 0;
    this._input = this.node.getElementsByTagName('input')[0];
    this._input.focus();
    // make users aware of the line history feature
    this._input.placeholder = '↑↓ for history';
    this._future = options.future;
    this._parent_header = options.parent_header;
    this._value = options.prompt + ' ';
  }

  /**
   * The value of the widget.
   */
  get value(): Promise<string> {
    return this._promise.promise.then(() => this._value);
  }

  /**
   * Handle the DOM events for the widget.
   *
   * @param event - The DOM event sent to the widget.
   *
   * #### Notes
   * This method implements the DOM `EventListener` interface and is
   * called in response to events on the dock panel's node. It should
   * not be called directly by user code.
   */
  handleEvent(event: KeyboardEvent): void {
    const input = this._input;
    if (event.type === 'keydown') {
      if (event.key === 'ArrowUp') {
        const historyLine = Stdin._historyAt(this._history_ix - 1);
        if (historyLine) {
          if (this._history_ix === 0) {
            this._value_cache = input.value;
          }
          input.value = historyLine;
          --this._history_ix;
        }
      } else if (event.key === 'ArrowDown') {
        if (this._history_ix === 0) {
          // do nothing
        } else if (this._history_ix === -1) {
          input.value = this._value_cache;
          ++this._history_ix;
        } else {
          const historyLine = Stdin._historyAt(this._history_ix + 1);
          if (historyLine) {
            input.value = historyLine;
            ++this._history_ix;
          }
        }
      } else if (event.key === 'Enter') {
        this._future.sendInputReply(
          {
            status: 'ok',
            value: input.value
          },
          this._parent_header
        );
        if (input.type === 'password') {
          this._value += Array(input.value.length + 1).join('·');
        } else {
          this._value += input.value;
          Stdin._historyPush(input.value);
        }
        this._promise.resolve(void 0);
      }
    }
  }

  /**
   * Handle `after-attach` messages sent to the widget.
   */
  protected onAfterAttach(msg: Message): void {
    this._input.addEventListener('keydown', this);
    this.update();
  }

  /**
   * Handle `update-request` messages sent to the widget.
   */
  protected onUpdateRequest(msg: Message): void {
    this._input.focus();
  }

  /**
   * Handle `before-detach` messages sent to the widget.
   */
  protected onBeforeDetach(msg: Message): void {
    this._input.removeEventListener('keydown', this);
  }

  private _history_ix: number;
  private _parent_header: KernelMessage.IInputReplyMsg['parent_header'];
  private _future: Kernel.IShellFuture;
  private _input: HTMLInputElement;
  private _value: string;
  private _value_cache: string;
  private _promise = new PromiseDelegate<void>();
}

export namespace Stdin {
  /**
   * The options to create a stdin widget.
   */
  export interface IOptions {
    /**
     * The prompt text.
     */
    prompt: string;

    /**
     * Whether the input is a password.
     */
    password: boolean;

    /**
     * The kernel future associated with the request.
     */
    future: Kernel.IShellFuture;

    /**
     * The header of the input_request message.
     */
    parent_header: KernelMessage.IInputReplyMsg['parent_header'];
  }
}

/** ****************************************************************************
 * Private namespace
 ******************************************************************************/

/**
 * A namespace for private data.
 */
namespace Private {
  /**
   * Create the node for an InputWidget.
   */
  export function createInputWidgetNode(
    prompt: string,
    password: boolean
  ): HTMLElement {
    const node = document.createElement('div');
    const promptNode = document.createElement('pre');
    promptNode.className = STDIN_PROMPT_CLASS;
    promptNode.textContent = prompt;
    const input = document.createElement('input');
    input.className = STDIN_INPUT_CLASS;
    if (password) {
      input.type = 'password';
    }
    node.appendChild(promptNode);
    promptNode.appendChild(input);
    return node;
  }

  /**
   * A renderer for IFrame data.
   */
  export class IsolatedRenderer
    extends Widget
    implements IRenderMime.IRenderer {
    /**
     * Create an isolated renderer.
     */
    constructor(wrapped: IRenderMime.IRenderer) {
      super({ node: document.createElement('iframe') });
      this.addClass('jp-mod-isolated');

      this._wrapped = wrapped;

      // Once the iframe is loaded, the subarea is dynamically inserted
      const iframe = this.node as HTMLIFrameElement & {
        heightChangeObserver: ResizeObserver;
      };

      iframe.frameBorder = '0';
      iframe.scrolling = 'auto';

      iframe.addEventListener('load', () => {
        // Workaround needed by Firefox, to properly render svg inside
        // iframes, see https://stackoverflow.com/questions/10177190/
        // svg-dynamically-added-to-iframe-does-not-render-correctly
        iframe.contentDocument!.open();

        // Insert the subarea into the iframe
        // We must directly write the html. At this point, subarea doesn't
        // contain any user content.
        iframe.contentDocument!.write(this._wrapped.node.innerHTML);

        iframe.contentDocument!.close();

        const body = iframe.contentDocument!.body;

        // Adjust the iframe height automatically
        iframe.style.height = `${body.scrollHeight}px`;
        iframe.heightChangeObserver = new ResizeObserver(() => {
          iframe.style.height = `${body.scrollHeight}px`;
        });
        iframe.heightChangeObserver.observe(body);
      });
    }

    /**
     * Render a mime model.
     *
     * @param model - The mime model to render.
     *
     * @returns A promise which resolves when rendering is complete.
     *
     * #### Notes
     * This method may be called multiple times during the lifetime
     * of the widget to update it if and when new data is available.
     */
    renderModel(model: IRenderMime.IMimeModel): Promise<void> {
      return this._wrapped.renderModel(model);
    }

    private _wrapped: IRenderMime.IRenderer;
  }

  export const currentPreferredMimetype = new AttachedProperty<
    IRenderMime.IRenderer,
    string
  >({
    name: 'preferredMimetype',
    create: owner => ''
  });

  /**
   * A `Panel` that's focused by a `contextmenu` event.
   */
  export class OutputPanel extends Panel {
    /**
     * Construct a new `OutputPanel` widget.
     */
    constructor(options?: Panel.IOptions) {
      super(options);
    }

    /**
     * A callback that focuses on the widget.
     */
    private _onContext(_: Event): void {
      this.node.focus();
    }

    /**
     * Handle `after-attach` messages sent to the widget.
     */
    protected onAfterAttach(msg: Message): void {
      super.onAfterAttach(msg);
      this.node.addEventListener('contextmenu', this._onContext.bind(this));
    }

    /**
     * Handle `before-detach` messages sent to the widget.
     */
    protected onBeforeDetach(msg: Message): void {
      super.onAfterDetach(msg);
      this.node.removeEventListener('contextmenu', this._onContext.bind(this));
    }
  }

  /**
   * Trimmed outputs information widget.
   */
  export class TrimmedOutputs extends Widget {
    /**
     * Widget constructor
     *
     * ### Notes
     * The widget will be disposed on click after calling the callback.
     *
     * @param maxNumberOutputs Maximal number of outputs to display
     * @param _onClick Callback on click event on the widget
     */
    constructor(
      maxNumberOutputs: number,
      onClick: (event: MouseEvent) => void
    ) {
      const node = document.createElement('div');
      node.insertAdjacentHTML(
        'afterbegin',
        `<a>
        <pre>Output of this cell has been trimmed on the initial display.</pre>
        <pre>Displaying the first ${maxNumberOutputs} top outputs.</pre>
        <pre>Click on this message to get the complete output.</pre>
      </a>`
      );
      super({
        node
      });
      this._onClick = onClick;
      this.addClass('jp-TrimmedOutputs');
      this.addClass('jp-RenderedHTMLCommon');
    }

    /**
     * Handle the DOM events for widget.
     *
     * @param event - The DOM event sent to the widget.
     *
     * #### Notes
     * This method implements the DOM `EventListener` interface and is
     * called in response to events on the widget's DOM node. It should
     * not be called directly by user code.
     */
    handleEvent(event: Event): void {
      if (event.type === 'click') {
        this._onClick(event as MouseEvent);
      }
    }

    /**
     * Handle `after-attach` messages for the widget.
     */
    protected onAfterAttach(msg: Message): void {
      super.onAfterAttach(msg);
      this.node.addEventListener('click', this);
    }

    /**
     * A message handler invoked on a `'before-detach'`
     * message
     */
    protected onBeforeDetach(msg: Message): void {
      super.onBeforeDetach(msg);
      this.node.removeEventListener('click', this);
    }

    private _onClick: (event: MouseEvent) => void;
  }
}

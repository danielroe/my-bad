export type ReportKind = 'error' | 'warning' | 'compile'

export type FrameType = 'app' | 'vendor' | 'native' | 'internal'

export type TokenType = 'keyword' | 'string' | 'number' | 'comment' | 'function' | 'type' | 'tag' | 'attribute' | 'operator' | 'punctuation' | 'variable' | 'text'

export interface Token {
  type: TokenType
  text: string
}

/**
 * Split one line of source into tokens, or return `undefined` to fall back to
 * the built-in tokenizer. Adapt any highlighter here (shiki, speed-highlight)
 * to get the same colours in HTML and ANSI output.
 */
export type Tokenizer = (line: string, lang: string | undefined) => Token[] | undefined

export interface Snippet {
  /** 1-based line number of `lines[0]`. */
  start: number
  lines: string[]
  lang?: string
  /** Pre-computed tokens per line, when a custom tokenizer was configured. */
  tokens?: Token[][]
}

/**
 * Whether a compile error's `loc` and `frame` describe transformed code rather
 * than the file they name. `{ sourceLoc }` also supplies the mapped source
 * position, when the thrower has one.
 */
export type CompiledMarker = boolean | { sourceLoc?: { file?: string, line: number, column?: number } }

export interface Location {
  file: string
  /** Path as shown to the user, when it cannot be derived from `cwd`. */
  displayFile?: string
  line?: number
  column?: number
  /** Source around the location, when it could be read. */
  snippet?: Snippet
}

export interface Frame {
  /** Absolute path or URL after sourcemapping. */
  file?: string
  /** Path as shown to the user, when it cannot be derived from `cwd`. */
  displayFile?: string
  line?: number
  column?: number
  function?: string
  type: FrameType
  isAsync?: boolean
  isConstructor?: boolean
  isEval?: boolean
  /** Location before sourcemapping, when it differs from the mapped one. */
  compiled?: Location
  snippet?: Snippet
  /** Original stack line. */
  raw?: string
}

export interface TraceEntry {
  label: string
  file?: string
  line?: number
  column?: number
  props?: Record<string, unknown>
}

export interface Section {
  id: string
  title: string
  content: Record<string, unknown> | string
  collapsed?: boolean
}

export interface ErrorReport {
  /** Stable hash of name, message and top app frame. */
  id: string
  kind: ReportKind
  name: string
  message: string
  code?: string
  hint?: string
  docsUrl?: string
  status?: number
  frames: Frame[]
  causes: ErrorReport[]
  /** Populated for `AggregateError`. */
  errors?: ErrorReport[]
  trace?: TraceEntry[]
  sections: Section[]
  rawStack?: string
  timestamp: number
}

export interface SourceLoader {
  name: string
  /**
   * Rewrite the frame to its original location. Return the updated frame,
   * `undefined` to let the next loader try, or `false` to stop mapping this frame.
   */
  map?: (frame: Frame) => Promise<Frame | false | undefined> | Frame | false | undefined
  /** Read source contents for a snippet. */
  read?: (file: string) => Promise<string | undefined> | string | undefined
  /**
   * Read the generated code a frame's compiled location refers to. Needed when
   * the compiled code lives in memory (module runners) rather than on disk.
   */
  readCompiled?: (file: string) => Promise<string | undefined> | string | undefined
}

export interface ReportContext {
  input: unknown
  options: ResolvedReportOptions
}

export interface ReportPlugin {
  name: string
  transform: (report: ErrorReport, ctx: ReportContext) => void | Promise<void>
}

export interface ReportPreset {
  plugins?: ReportPlugin[]
  internal?: (string | RegExp)[]
  loaders?: SourceLoader[]
}

export interface ReportOptions {
  cwd?: string
  kind?: ReportKind
  loaders?: SourceLoader[]
  /** Patterns matched against `file` and `function` to classify frames as `internal`. */
  internal?: (string | RegExp)[]
  plugins?: ReportPlugin[]
  presets?: ReportPreset[]
  maxCauses?: number
  snippetLines?: number
  /** Skip snippet loading entirely. */
  snippets?: boolean
  /** Arbitrary data for plugins: request, event, Vue instance, route... */
  context?: Record<string, unknown>
  /** Custom syntax tokenizer for snippets. Tokens are stored on the report. */
  tokenizer?: Tokenizer
  /**
   * For `kind: 'compile'`, whether the error's `loc` and `frame` describe the
   * transformed module rather than the file they name. They then land on
   * `frame.compiled` and the frame gets no misleading source line or snippet.
   *
   * Detected automatically when the frame's caret line does not appear at that
   * position in the file on disk; pass `true` to force it, `false` to opt out,
   * or `{ sourceLoc }` when a mapped source position is known, to get a source
   * snippet alongside the generated one.
   *
   * Applies to the top-level input only. A `compiled` marker on the input
   * itself wins, for the input that carries it.
   */
  compiled?: CompiledMarker
}

export interface ResolvedReportOptions {
  cwd: string
  kind?: ReportKind
  loaders: SourceLoader[]
  internal: (string | RegExp)[]
  plugins: ReportPlugin[]
  maxCauses: number
  snippetLines: number
  snippets: boolean
  context: Record<string, unknown>
  tokenizer?: Tokenizer
  compiled?: CompiledMarker
}

/** Shape of a Vite `ErrorPayload['err']`, accepted as input alongside `Error`. */
export interface CompileErrorInput {
  message: string
  stack?: string
  id?: string
  frame?: string
  plugin?: string
  pluginCode?: string
  loc?: { file?: string, line: number, column: number } | { file?: string, start: { line: number, column: number } }
  name?: string
  /**
   * Same meaning as `ReportOptions.compiled`, but carried by the error, so a
   * thrower that already knows its `frame` came from transformed code can say
   * so without the report having to guess. Honoured wherever the error appears
   * in the chain: top level, a `cause` at any depth, or a member of `errors`.
   *
   * Takes precedence over `ReportOptions.compiled` for the error that carries
   * it, and over the automatic detection in both directions. A hint to the
   * report builder; never included in the report.
   */
  compiled?: CompiledMarker
}

export interface HistoryEntry {
  id: string
  kind: ReportKind
  name: string
  message: string
  timestamp: number
}

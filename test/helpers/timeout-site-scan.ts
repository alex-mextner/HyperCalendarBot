// Finds the deadline sites of one source file and the callable each one lives in, so the timeout
// guard can demand a reportTimeout() per site instead of per file. A file that reports one deadline
// must not hide a second, unreported one in another function.
//
// A "unit" is the outermost named callable around a site: a top-level function, `Class.method`, or a
// top-level `const f = () => ...`. Closures and callbacks belong to the unit they sit in, because a
// timer callback reports on behalf of the function that armed it. The remaining blind spot is two
// deadlines inside ONE unit with a single report between them; the guard cannot tell those apart.
import ts from 'typescript';

/** The calls that enforce or race a deadline. */
const DEADLINE_CALLS = /^(AbortSignal\.timeout|Promise\.race|setTimeout|Bun\.sleep)$|\.waitUntilFinished$/;
/** SDK and HTTP client options that carry a deadline (`new Anthropic({ timeout })`). */
const TIMEOUT_OPTION = /^timeout$/;
const SQLITE_BUSY_TIMEOUT = /busy_timeout/;
/** The calls that hand a timeout to the repair flow; reportIfDatabaseBusy forwards a locked-database error as one. */
const REPORT_CALLS = new Set(['reportTimeout', 'reportIfDatabaseBusy']);

export interface DeadlineSite {
  /** `Class.method`, `function`, or `<module>` for code outside any callable. */
  unit: string;
  /** What was found, e.g. `setTimeout(` or `option timeout`. */
  what: string;
  line: number;
}

export interface UnitScan {
  /** Every deadline site, in source order. */
  sites: DeadlineSite[];
  /** Units that contain a reportTimeout() call. */
  reporting: Set<string>;
}

/** The name a callable node contributes to its unit, or null when the node is not a unit boundary. */
function callableName(cur: ts.Node): string | null {
  if (ts.isFunctionDeclaration(cur)) return cur.name?.text ?? 'default';
  if (ts.isConstructorDeclaration(cur)) return 'constructor';
  // Object-literal methods belong to the function that builds the object, not to a unit of their own.
  if ((ts.isMethodDeclaration(cur) || ts.isGetAccessor(cur) || ts.isSetAccessor(cur)) && ts.isClassLike(cur.parent)) {
    return cur.name.getText();
  }
  if (ts.isPropertyDeclaration(cur) && cur.initializer && ts.isClassLike(cur.parent)) return cur.name.getText();
  const topLevelArrow =
    (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
    ts.isVariableDeclaration(cur.parent) &&
    ts.isSourceFile(cur.parent.parent.parent.parent);
  return topLevelArrow ? cur.parent.name.getText() : null;
}

function unitOf(node: ts.Node): string {
  let outer: string | null = null;
  let className: string | null = null;
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    if (ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) className = cur.name?.text ?? 'class';
    else outer = callableName(cur) ?? outer;
  }
  if (outer === null) return className ?? '<module>';
  return className ? `${className}.${outer}` : outer;
}

/** What a node is, for the scan: a report, a deadline of some kind, or neither. */
type Classified = { report: true } | { deadline: string } | null;

function classifyCall(node: ts.CallExpression, file: ts.SourceFile): Classified {
  const callee = node.expression.getText(file);
  if (REPORT_CALLS.has(callee)) return { report: true };
  return DEADLINE_CALLS.test(callee) ? { deadline: `${callee}(` } : null;
}

function classify(node: ts.Node, file: ts.SourceFile): Classified {
  if (ts.isCallExpression(node)) return classifyCall(node, file);
  if (ts.isNewExpression(node) && node.expression.getText(file) === 'DOMException') {
    const timeoutError = node.arguments?.some((arg) => ts.isStringLiteralLike(arg) && arg.text === 'TimeoutError');
    return timeoutError ? { deadline: 'DOMException TimeoutError' } : null;
  }
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    const isOption = TIMEOUT_OPTION.test(node.name.getText(file)) && ts.isObjectLiteralExpression(node.parent);
    return isOption ? { deadline: 'option timeout' } : null;
  }
  const busy =
    (ts.isStringLiteralLike(node) && SQLITE_BUSY_TIMEOUT.test(node.text)) ||
    (ts.isTemplateExpression(node) && SQLITE_BUSY_TIMEOUT.test(node.head.text));
  return busy ? { deadline: 'busy_timeout' } : null;
}

export function scanDeadlineSites(fileName: string, source: string): UnitScan {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const sites: DeadlineSite[] = [];
  const reporting = new Set<string>();

  const visit = (node: ts.Node): void => {
    const found = classify(node, file);
    if (found && 'report' in found) reporting.add(unitOf(node));
    else if (found) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      sites.push({ unit: unitOf(node), what: found.deadline, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { sites, reporting };
}

/** `file#unit` for every unit that has a deadline site and no reportTimeout() call. */
export function unreportedUnits(fileName: string, source: string): string[] {
  const { sites, reporting } = scanDeadlineSites(fileName, source);
  const units = new Set(sites.map((site) => site.unit));
  return [...units].filter((unit) => !reporting.has(unit)).map((unit) => `${fileName}#${unit}`);
}

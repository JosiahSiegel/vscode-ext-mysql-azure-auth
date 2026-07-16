// scripts/licenses-spdx.mjs
//
// Todo 13 — SPDX expression normalization helper.
//
// The plan body mandates a canonical, reproducible form for every SPDX
// expression so that the validator can compare license-exception approvals
// against the actual declarations emitted by license-checker-rseidelsohn:
//
//   > normalization uses the lockfile-pinned spdx-expression-parse AST
//   > serialized recursively with identifiers in original canonical SPDX
//   > casing, parentheses preserved by AST precedence, and commutative
//   > AND/OR child strings sorted lexicographically; parser failure is
//   > LICENSE NOT READY: INVALID SPDX
//
// SPDX precedence: `AND` binds tighter than `OR`. When serializing an AST
// node whose parent is `OR`, an `AND` child does NOT need parentheses.
// When the parent is `AND`, an `OR` child DOES need parentheses.
//
// This module is intentionally framework-free (no await, no I/O) so
// scripts/licenses.mjs and scripts/verify-task.mjs can both import it
// during their validation loops.

import parseSpdx from "spdx-expression-parse";

const PRECEDENCE = {
  AND: 2,
  OR: 1,
};

function precedenceOf(op) {
  if (typeof op !== "string") return 0;
  const upper = op.toUpperCase();
  return PRECEDENCE[upper] ?? 0;
}

function nodeOp(node) {
  if (!node || typeof node !== "object") return null;
  if (typeof node.conjunction === "string") {
    return String(node.conjunction).toUpperCase();
  }
  return null;
}

/**
 * Serialize an SPDX AST node into its canonical form.
 *
 * @param {unknown} ast output of spdx-expression-parse
 * @returns {string} canonical form
 */
export function serializeAst(ast) {
  if (ast === null || typeof ast !== "object") return "";

  if (typeof ast.license === "string" && typeof ast.exception === "string") {
    return `${ast.license} WITH ${ast.exception}`;
  }
  if (typeof ast.license === "string") return ast.license;
  if (typeof ast.expression === "string") return ast.expression;

  const op = nodeOp(ast);
  if (op && ast.left && ast.right) {
    const parentPrec = precedenceOf(op);
    const leftSer = serializeNode(ast.left, parentPrec, op);
    const rightSer = serializeNode(ast.right, parentPrec, op);
    // Commutative reordering: when both sides are the same associative
    // operator (AND, AND) or (OR, OR), we still want the canonical
    // lexicographic ordering of the rendered sibling strings.
    const opUpper = op.toUpperCase();
    const sorted = leftSer <= rightSer ? [leftSer, rightSer] : [rightSer, leftSer];
    return `${sorted[0]} ${opUpper} ${sorted[1]}`;
  }
  return "";
}

function serializeNode(node, parentPrec, parentOp) {
  const ser = serializeAst(node);
  if (typeof ser !== "string" || ser.length === 0) return ser;
  const op = nodeOp(node);
  if (op === null) {
    // Atom: only need parens when wrapped in a same-op parent as a
    // sibling group. Within an associative parent the parser flattens
    // a same-op chain so an atom sibling never appears as a compound.
    return ser;
  }
  const nodePrec = precedenceOf(op);
  if (nodePrec < parentPrec) {
    return `(${ser})`;
  }
  // Same or tighter precedence: no extra parens needed.
  void parentOp;
  return ser;
}

/**
 * Parse and normalize an SPDX expression. Throws on parser failure.
 *
 * @param {string} expression SPDX expression
 * @returns {string} canonical, normalized form
 */
export function normalizeSpdx(expression) {
  if (typeof expression !== "string" || expression.length === 0) {
    throw new Error("empty expression");
  }
  let ast;
  try {
    ast = parseSpdx(expression);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    throw new Error(`parser failure: ${message}`);
  }
  return serializeAst(ast);
}

/**
 * Compare two SPDX expressions for equality after normalization.
 *
 * @param {string} a first expression
 * @param {string} b second expression
 * @returns {boolean} true when both parse and normalize to identical strings
 */
export function spdxEquals(a, b) {
  try {
    return normalizeSpdx(a) === normalizeSpdx(b);
  } catch {
    return false;
  }
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const paths = process.argv.slice(2).filter((argument) => argument !== "--fixture");
const documentPaths = paths.length > 0 ? paths : ["README.md", "BUILD.md"];
const mutableTestCount = /\b\d[\d,]*\s+(?:unit\s+|integration\s+)?tests?\b/giu;
const findings = [];

for (const documentPath of documentPaths) {
  const content = await readFile(resolve(process.cwd(), documentPath), "utf8");
  for (const match of content.matchAll(mutableTestCount)) {
    const line = content.slice(0, match.index).split("\n").length;
    findings.push(`${documentPath}:${line}:${match[0]}`);
  }
}

if (findings.length > 0) {
  console.error("STALE_COUNT_CLAIM");
  for (const finding of findings) {
    console.error(finding);
  }
  process.exitCode = 1;
}

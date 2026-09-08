#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const RESERVED_MARKERS = [
  /^<!--\s*doc-agent:\s*source-id=/,
  /^<!--\s*memmy-release-notes-source(?:\s|-->|$)/,
  /^<!--\s*memmy-release-evidence(?:\s|-->|$)/,
];

function isReservedMarker(value) {
  return RESERVED_MARKERS.some((pattern) => pattern.test(value));
}

function reservedMarkerOffset(line) {
  let offset = line.indexOf("<!--");
  while (offset !== -1) {
    if (isReservedMarker(line.slice(offset))) return offset;
    offset = line.indexOf("<!--", offset + 4);
  }
  return -1;
}

function fenceOpening(line) {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  return { character: match[1][0], length: match[1].length };
}

function isFenceClosing(line, fence) {
  const escaped = fence.character === "`" ? "`" : "~";
  return new RegExp(`^[ \\t]{0,3}${escaped}{${fence.length},}[ \\t]*$`).test(line);
}

function assertCommentOccupiesCompleteLines(line, markerOffset, lineNumber) {
  if (line.slice(0, markerOffset).trim() !== "") {
    throw new Error(
      `Reserved release metadata must occupy complete lines (line ${lineNumber})`,
    );
  }
}

export function sanitizeReleaseNotes(markdown) {
  const lines = markdown.split(/\r?\n/);
  const publicLines = [];
  let fence = null;
  let removingReservedComment = false;
  let reservedCommentStart = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    if (removingReservedComment) {
      const closeOffset = line.indexOf("-->");
      if (closeOffset === -1) continue;

      if (line.slice(closeOffset + 3).trim() !== "") {
        throw new Error(
          `Reserved release metadata must occupy complete lines (line ${lineNumber})`,
        );
      }

      removingReservedComment = false;
      continue;
    }

    if (fence) {
      publicLines.push(line);
      if (isFenceClosing(line, fence)) fence = null;
      continue;
    }

    const openingFence = fenceOpening(line);
    if (openingFence) {
      fence = openingFence;
      publicLines.push(line);
      continue;
    }

    const markerOffset = reservedMarkerOffset(line);
    if (markerOffset === -1) {
      publicLines.push(line);
      continue;
    }

    assertCommentOccupiesCompleteLines(line, markerOffset, lineNumber);
    const closeOffset = line.indexOf("-->", markerOffset + 4);
    if (closeOffset === -1) {
      removingReservedComment = true;
      reservedCommentStart = lineNumber;
      continue;
    }

    if (line.slice(closeOffset + 3).trim() !== "") {
      throw new Error(
        `Reserved release metadata must occupy complete lines (line ${lineNumber})`,
      );
    }
  }

  if (removingReservedComment) {
    throw new Error(
      `Unterminated reserved release metadata starting at line ${reservedCommentStart}`,
    );
  }

  const publicMarkdown = publicLines.join("\n").trimEnd();
  if (publicMarkdown.trim() === "") {
    throw new Error("Release notes contain no public content after sanitization");
  }

  const sanitized = `${publicMarkdown}\n`;
  assertNoReservedMetadata(sanitized);
  return sanitized;
}

function assertNoReservedMetadata(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (isFenceClosing(line, fence)) fence = null;
      continue;
    }

    const openingFence = fenceOpening(line);
    if (openingFence) {
      fence = openingFence;
      continue;
    }

    if (reservedMarkerOffset(line) !== -1) {
      throw new Error(
        `Reserved release metadata remains after sanitization (line ${index + 1})`,
      );
    }
  }
}

function main() {
  const [inputArg, outputArg, ...extraArgs] = process.argv.slice(2);
  if (!inputArg || !outputArg || extraArgs.length > 0) {
    throw new Error("Usage: node scripts/sanitize-release-notes.mjs <input.md> <output.md>");
  }

  const inputPath = resolve(inputArg);
  const outputPath = resolve(outputArg);
  if (inputPath === outputPath) {
    throw new Error("Input and output paths must be different");
  }

  const markdown = readFileSync(inputPath, "utf8");
  const sanitized = sanitizeReleaseNotes(markdown);
  writeFileSync(outputPath, sanitized, "utf8");
}

try {
  main();
} catch (error) {
  console.error(`sanitize-release-notes: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

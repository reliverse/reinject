import { loadConfig } from "c12";
import fs from "fs-extra";
import path from "pathe";
import { execa } from "execa";
import { relinka } from "@reliverse/prompts";

//-------------------------------------
// 1) c12 config interface
//-------------------------------------
interface ReinjectUserConfig {
  // The comment to inject above each error line
  injectComment?: string;
  // The command used to spawn tsc (e.g. "tsc --noEmit --project tsconfig.json")
  tscCommand?: string;
}

//-------------------------------------
// 2) Load c12 configs
//-------------------------------------
async function loadReinjectConfig(): Promise<ReinjectUserConfig> {
  const { config } = await loadConfig<ReinjectUserConfig>({
    name: "reinject", // tries reinject.config.*, .reinjectrc, etc.
    defaults: {},
    overrides: {},
    dotenv: false,
    packageJson: false,
  });

  return {
    injectComment: config.injectComment ?? "// @ts-expect-error TODO: fix ts",
    tscCommand: config.tscCommand ?? "tsc --noEmit",
  };
}

//-------------------------------------
// 3) parseLineRefs from a lines file
//-------------------------------------
async function parseLinesFile(linesFile: string) {
  const fileContents = await fs.readFile(linesFile, "utf-8");
  const splitted = fileContents.split(/\r?\n/);
  const results: { filePath: string; lineNumber: number }[] = [];

  for (const rawLine of splitted) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Could match "N  path.ts:line"
    let match = trimmed.match(/^(\d+)\s+(.+?):(\d+)$/);
    if (match) {
      results.push({
        filePath: match[2],
        lineNumber: parseInt(match[3], 10),
      });
      continue;
    }

    // Or "path.ts:line"
    match = trimmed.match(/^(.+?):(\d+)$/);
    if (match) {
      results.push({
        filePath: match[1],
        lineNumber: parseInt(match[2], 10),
      });
    } else {
      relinka("warn", `Line doesn't match expected format: ${trimmed}`);
    }
  }
  return results;
}

//-------------------------------------
// 4) parseTscErrors: run tsc with execa, parse error lines
// Example TSC error line format:
//   src/foo.ts(12,5): error TS2322:
// We'll capture `src/foo.ts`, `12` as line
//-------------------------------------
async function runTscAndParseErrors(tscCommand: string): Promise<Array<{ filePath: string; lineNumber: number }>> {
  // execa runs the command in a shell by default if we do e.g. { shell: true }
  // But we can parse the normal stdout/stderr if we handle it ourselves.
  let linesRefs: Array<{ filePath: string; lineNumber: number }> = [];

  try {
    // We expect TSC to fail if there are any errors, so we catch that in .catch
    const { stdout, stderr } = await execa(tscCommand, {
      shell: true, // shell mode to interpret the command
      all: true,   // capture combined output in .all
    });

    // Merge both stdout and stderr
    const combinedOutput = [stdout, stderr].join("\n");

    // typical line:
    //   src/foo.ts(10,5): error TSxxxx ...
    // or:   C:\abs\path\to\file.ts(35,12): error TS9999
    const splitted = combinedOutput.split(/\r?\n/);
    const regex = /^(.+?)\((\d+),(\d+)\): error TS\d+: /;

    for (const line of splitted) {
      const trimmed = line.trim();
      const m = trimmed.match(regex);
      if (m) {
        let file = m[1];
        const row = parseInt(m[2], 10);
        // column = parseInt(m[3], 10);
        if (row > 0) {
          // Convert Windows backslashes
          file = file.replace(/\\/g, "/");
          linesRefs.push({
            filePath: file,
            lineNumber: row,
          });
        }
      }
    }
  } catch (error: any) {
    // TSC might fail with exit code 2 (or something else) if there are errors,
    // so we parse from the error's output. execa's error object has .stdout/.stderr
    // if we used all: true => .all
    // if we used separate => error.stdout, error.stderr
    // We'll handle it as below:
    const combined = (error.all as string) || "";
    if (!combined) {
      // No output => maybe TSC succeeded or no errors
      relinka("info", `TSC returned no error lines. Possibly no TS errors?`);
      return [];
    }

    const splitted = combined.split(/\r?\n/);
    const regex = /^(.+?)\((\d+),(\d+)\): error TS\d+: /;

    for (const line of splitted) {
      const m = line.trim().match(regex);
      if (m) {
        let file = m[1];
        const row = parseInt(m[2], 10);
        if (row > 0) {
          file = file.replace(/\\/g, "/");
          linesRefs.push({ filePath: file, lineNumber: row });
        }
      }
    }
  }

  return linesRefs;
}

//-------------------------------------
// 5) The injection logic
//-------------------------------------
async function injectCommentIntoFiles(
  linesRecords: Array<{filePath: string; lineNumber: number}>,
  commentText: string,
) {
  // group by file
  const byFile = new Map<string, number[]>();
  for (const rec of linesRecords) {
    if (!byFile.has(rec.filePath)) {
      byFile.set(rec.filePath, []);
    }
    byFile.get(rec.filePath)!.push(rec.lineNumber);
  }

  for (const [filePath, lineNums] of byFile.entries()) {
    // sort descending
    lineNums.sort((a,b) => b - a);

    const absPath = path.resolve(filePath);
    relinka("info", `Injecting into ${absPath} at lines: ${lineNums.join(", ")}`);

    try {
      const original = await fs.readFile(absPath, "utf-8");
      const splitted = original.split(/\r?\n/);
      for (const ln of lineNums) {
        if (ln <= splitted.length) {
          splitted.splice(ln - 1, 0, commentText);
        } else {
          relinka("warn", `Line ${ln} exceeds file length for ${absPath}`);
        }
      }
      const newContent = splitted.join("\n");
      await fs.writeFile(absPath, newContent, "utf-8");
    } catch (error) {
      relinka("error", `Failed editing ${filePath}: ${error}`);
    }
  }
}

//-------------------------------------
// 6) The main usage function
//-------------------------------------
export async function useTsExpectError(args: { files: string[], comment?: string }) {
  // 1) load c12 config
  const userConfig = await loadReinjectConfig();
  const finalComment = args.comment || userConfig.injectComment!;

  // gather references
  const lines: Array<{filePath: string; lineNumber: number}> = [];

  // if "auto" => run TSC
  let usedAuto = false;
  for (const item of args.files) {
    if (item.toLowerCase() === "auto") {
      usedAuto = true;
    }
  }

  if (usedAuto) {
    relinka("info", "Running TSC to discover error lines...");
    const tscCommand = userConfig.tscCommand!;
    try {
      const discovered = await runTscAndParseErrors(tscCommand);
      lines.push(...discovered);
    } catch (error) {
      relinka("error", `Failed running tsc: ${error}`);
      process.exit(1);
    }
  }

  // parse lines from each file that isn't "auto"
  for (const item of args.files) {
    if (item.toLowerCase() === "auto") continue;

    try {
      const recs = await parseLinesFile(item);
      lines.push(...recs);
    } catch (error) {
      relinka("error", `Failed reading lines file ${item}: ${error}`);
    }
  }

  if (lines.length === 0) {
    relinka("error", "No references found. Nothing to do.");
    process.exit(1);
  }

  await injectCommentIntoFiles(lines, finalComment);
  relinka("success", "All lines processed successfully.");
}

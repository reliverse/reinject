import { defineCommand, errorHandler, runMain } from "@reliverse/prompts";

const main = defineCommand({
  meta: {
    name: "reinject",
    version: "1.0.0",
    description: "@reliverse/reinject-cli",
  },
  args: {
    dev: {
      type: "boolean",
      description: "Runs the CLI in dev mode",
    },
    fileType: {
        type: "string",
        description: "File type to initialize (e.g. 'md:README')",
        required: false,
      },
      destDir: {
        type: "string",
        description: "Destination directory",
        default: ".",
        required: false,
      },
      multiple: {
        type: "boolean",
        description: "Whether to select multiple file types from the library",
        required: false,
        default: false,
      },
      parallel: {
        type: "boolean",
        description: "Run tasks in parallel",
        required: false,
        default: false,
      },
      concurrency: {
        type: "string",
        description: "Concurrency limit if parallel is true",
        required: false,
        default: "4",
      },
  },
  subCommands: {
    cli: () => import("./cli/cli-mod.js").then((r) => r.default),
    add: () => import("./cli/args/arg-ts-expect-error.js").then((r) => r.default),
  }
});

await runMain(main).catch((error: unknown) => {
  errorHandler(
    error instanceof Error ? error : new Error(String(error)),
    "An unhandled error occurred, please report it at https://github.com/reliverse/reinject",
  );
});

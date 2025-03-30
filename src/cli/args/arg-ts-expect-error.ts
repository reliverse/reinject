import { defineCommand } from "@reliverse/prompts";
import { relinka } from "@reliverse/prompts";
import { useTsExpectError } from "~/libs/sdk/sdk-impl/ts-expect-error.js";

export default defineCommand({
  meta: {
    name: "ts-expect-error",
    description:
      "Inject `@ts-expect-error` above lines where TS errors occur",
  },
  args: {
    dev: {
      type: "boolean",
      description: "Run the CLI in dev mode",
    },
    files: {
      type: "positional",
      array: true,
      required: true,
      description: `'auto' or path(s) to line references file(s)`,
    },
    comment: {
      type: "string",
      required: false,
      description: "Override the comment line to insert. Default is `// @ts-expect-error TODO: fix ts`",
    },
  },
  run: async ({ args }) => {
    const isDev = args.dev;
    if (isDev) {
      relinka("log-verbose", "Using dev mode");
    }

    await useTsExpectError({
      files: [args.files],
      comment: args.comment,
    });

    process.exit(0);
  },
});

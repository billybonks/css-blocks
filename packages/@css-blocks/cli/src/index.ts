import {
  BlockFactory,
  CssBlockError,
  ErrorWithPosition,
  Importer,
  NodeJsImporter,
  Preprocessors,
  charInFile,
  errorHasRange,
  hasMappedPosition,
} from "@css-blocks/core";
import chalk = require("chalk");
import fse = require("fs-extra");
import path = require("path");
import yargs = require("yargs");

import { ExtractionResult, extractLinesFromSource } from "./extract-lines-from-source";

type Aliases = ConstructorParameters<typeof NodeJsImporter>[0];

/**
 * Typecast for result of command line argument parsing.
 */
interface GlobalArgs {
  preprocessors: string | undefined;
  alias: Array<string | number> | undefined;
  npm: boolean | undefined;
  [k: string]: unknown;
}

/**
 * Typecast for result of command line argument parsing.
 */
interface ValidateArgs extends GlobalArgs {
  blocks: unknown;
}

interface ValidateOptions {
  /**
   * A path to the preprocessors code.
   */
  preprocessors?: string;
  alias?: Array<string | number>;
  npm?: boolean;
}

export class CLI {
  constructor() {
  }

  /**
   * Parse the arguments and run the corresponding code.
   */
  run(args: Array<string>): Promise<void> {
    let argv = this.argumentParser().parse(args);
    if (argv.promise) {
      return argv.promise as Promise<void>;
    } else {
      return Promise.resolve();
    }
  }

  /**
   * this is an instance method so tests can disable it.
   */
  get chalk() {
    return chalk.default;
  }

  /**
   * Construct the argument parser using yargs.
   */
  argumentParser() {
    return yargs
      .scriptName("css-blocks")
      .usage("$0 <cmd> [options] block-dir-or-file...")
      .version()
      .strict()
      .option("preprocessors", {
        type: "string",
        global: true,
        description: "A JS file that exports an object that maps extensions to a preprocessor function for that type.",
        nargs: 1,
      })
      .option("npm", {
        type: "boolean",
        global: true,
        description: "Allow importing from node_modules",
        nargs: 0,
      })
      .option("alias", {
        type: "array",
        global: true,
        description: "Define an import alias. Requires two arguments: an alias and a directory.",
        implies: "npm",
        nargs: 2,
      })
      .command<ValidateArgs>(
        "validate <blocks..>",
        "Validate block file syntax.", (y) =>
          y.positional("blocks", {
            description: "files or directories containing css blocks.",
          }),
        (argv: ValidateArgs) => {
          let { preprocessors, alias, npm } = argv;
          argv.promise = this.validate(argv.blocks as Array<string>, {
            preprocessors,
            alias,
            npm,
          });
        },
      )
      .wrap(yargs.terminalWidth())
      .demandCommand(1, "No command was provided.")
      .help();
  }

  /**
   * Validate the syntax of a list of block files.
   */
  async validate(blockFiles: Array<string>, options: ValidateOptions) {
    let preprocessors: Preprocessors = options.preprocessors ? require(path.resolve(options.preprocessors)) : {};
    let npm = options.npm || false;
    let aliases: Aliases = [];
    let aliasList = options.alias || [];
    for (let i = 0; i < aliasList.length; i = i + 2) {
      let alias = aliasList[i].toString();
      let dir = path.resolve(aliasList[i + 1].toString());
      aliases.push({alias, path: dir});
    }
    let importer: Importer | undefined;
    if (npm) {
      importer = new NodeJsImporter(aliases);
    }
    let factory = new BlockFactory({preprocessors, importer});
    let errorCount = 0;
    for (let blockFile of blockFiles) {
      let blockFileRelative = path.relative(process.cwd(), path.resolve(blockFile));
      try {
        if (importer) {
          let ident = importer.identifier(null, blockFile, factory.configuration);
          blockFile = importer.filesystemPath(ident, factory.configuration) || blockFile;
        }
        await factory.getBlockFromPath(path.resolve(blockFile));
        // if the above line doesn't throw then there wasn't a syntax error.
        this.println(`${this.chalk.green("ok")}\t${this.chalk.whiteBright(blockFileRelative)}`);
      } catch (e) {
        errorCount++;
        if (e instanceof CssBlockError) {
          let loc = e.location;
          let message = `${this.chalk.red("error")}\t${this.chalk.whiteBright(blockFileRelative)}`;
          if (!errorHasRange(loc)) {
            this.println(message, e.origMessage);
            continue;
          } else {
            this.println(message);
            this.displayError(blockFileRelative, e);
          }
        } else {
          console.error(e);
        }
      }
    }
    if (errorCount) {
      this.println(`Found ${this.chalk.redBright(`${errorCount} error${errorCount > 1 ? "s" : ""}`)} in ${blockFiles.length} file${blockFiles.length > 1 ? "s" : ""}.`);
    }
    this.exit(errorCount);
  }

  displayError(blockFileRelative: string, e: CssBlockError) {
    let loc = e.location;
    if (!loc) return;
    if (!errorHasRange(loc)) return;
    let filename = path.relative(process.cwd(), path.resolve(loc && loc.filename || blockFileRelative));
    this.println("\t" + this.chalk.bold.redBright(e.origMessage));
    for (let referenceLocation of e.importStack.reverse()) {
      if (referenceLocation.filename) {
        referenceLocation.filename = path.relative(process.cwd(), path.resolve(referenceLocation.filename));
      }
      this.println(
        this.chalk.bold.white("\tIn block referenced at"),
        this.chalk.bold.whiteBright(charInFile(referenceLocation)),
      );
    }
    if (hasMappedPosition(loc)) {
      this.println(
        this.chalk.bold.white("\tAt compiled output of"),
        this.chalk.bold.whiteBright(charInFile(loc.generated)),
      );
      this.displaySnippet(extractLinesFromSource(loc.generated), loc.generated);
    }
    this.println(
      this.chalk.bold.white(hasMappedPosition(loc) ? "\tSource Mapped to" : "\tAt"),
      this.chalk.bold.whiteBright(charInFile(filename, loc.start)),
    );
    this.displaySnippet(extractLinesFromSource(loc), loc);
  }

  displaySnippet(context: ExtractionResult | undefined, loc: ErrorWithPosition) {
    if (!context) return;
    let lineNumber: number | undefined;
    lineNumber = loc.start.line - context.additionalLines.before;

    for (let i = 0; i < context.lines.length; i++) {
      let prefix;
      let line = context.lines[i];
      if (i < context.additionalLines.before ||
          i >= context.lines.length - context.additionalLines.after) {
        prefix = this.chalk.bold(`${lineNumber}:${line ? " " : ""}`);
      } else {
        prefix = this.chalk.bold.redBright(`${lineNumber}:${line ? " " : ""}`);
        let {before, during, after } = this.splitLineOnErrorRange(line, lineNumber, loc);
        line = `${before}${this.chalk.underline.redBright(during)}${after}`;
      }
      this.println("\t" + prefix + line);
      if (lineNumber) lineNumber++;
    }
  }

  splitLineOnErrorRange(line: string, lineNumber: number, loc: ErrorWithPosition) {
    if (lineNumber === loc.start.line && lineNumber === loc.end.line) {
      let before = line.slice(0, loc.start.column - 1);
      let during = line.slice(loc.start.column - 1, loc.end.column);
      let after = line.slice(loc.end.column);
      return { before, during, after };
    } else if (lineNumber === loc.start.line) {
      let before = line.slice(0, loc.start.column - 1);
      let during = line.slice(loc.start.column - 1);
      return { before, during, after: "" };
    } else if (lineNumber === loc.end.line) {
      let leadingWhitespace = "";
      let during = line.slice(0, loc.end.column);
      if (during.match(/^(\s+)/)) {
        leadingWhitespace = RegExp.$1;
        during = during.replace(/^\s+/, "");
      }
      let after = line.slice(loc.end.column);
      return {before: leadingWhitespace, during, after };
    } else {
      let leadingWhitespace = "";
      if (line.match(/^(\s+)/)) {
        leadingWhitespace = RegExp.$1;
        line = line.replace(/^\s+/, "");
      }
      return {before: leadingWhitespace, during: line, after: "" };
    }
  }
  /**
   * Instance method so tests can easily capture output.
   */
  println(...args: Array<string>) {
    // tslint:disable-next-line:no-console
    console.log(...args);
  }

  /**
   * Instance method so tests can intercept the file write.
   */
  async writeFile(filename: string, contents: string): Promise<void> {
    await fse.mkdirp(path.dirname(filename));
    return fse.writeFile(filename, contents, "utf8");
  }

  /**
   * Instance method so tests can record the exit code without exiting.
   */
  exit(code = 0) {
    process.exit(code);
  }
}

import { DotfilesError } from "../errors.ts";

class ShellLexer {
  readonly words: string[] = [];
  #word = "";
  #active = false;
  #quote: "'" | '"' | undefined;

  #append(char: string): void {
    this.#word += char;
    this.#active = true;
  }

  #flush(): void {
    if (this.#active) this.words.push(this.#word);
    this.#word = "";
    this.#active = false;
  }

  #quoted(char: string): void {
    if (char === this.#quote) this.#quote = undefined;
    else this.#append(char);
  }

  #escaped(text: string, index: number): number {
    const next = text[index + 1];
    if (next === undefined)
      throw new DotfilesError("Flags end with an incomplete escape");
    this.#append(
      this.#quote && next !== this.#quote && next !== "\\" ? `\\${next}` : next,
    );
    return index + 1;
  }

  feed(text: string, index: number): number {
    const char = text[index] ?? "";
    if (this.#quote === "'") {
      this.#quoted(char);
      return index;
    }
    if (char === "\\") return this.#escaped(text, index);
    if (this.#quote === '"') {
      this.#quoted(char);
      return index;
    }
    if (char === "'" || char === '"') {
      this.#quote = char;
      this.#active = true;
    } else if (char === "#") {
      this.#flush();
      const newline = text.indexOf("\n", index);
      return newline < 0 ? text.length : newline;
    } else if (/\s/.test(char)) this.#flush();
    else this.#append(char);
    return index;
  }

  finish(): string[] {
    if (this.#quote) throw new DotfilesError("Flags contain an unclosed quote");
    this.#flush();
    return this.words;
  }
}

// Parse flags with POSIX shlex quoting and comments, without shell expansion
export function shellWords(text: string): string[] {
  const lexer = new ShellLexer();
  for (let index = 0; index < text.length; index++) index = lexer.feed(text, index);
  return lexer.finish();
}

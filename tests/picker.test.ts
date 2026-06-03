import { describe, expect, test } from "bun:test";
import { PassThrough, Readable, Writable } from "node:stream";
import { pickFromList, pickMultipleFromList } from "../src/ui/picker.ts";

function stringStream(s: string): Readable {
  const r = new Readable();
  r.push(s);
  r.push(null);
  return r;
}

function bufferingWritable(): { stream: Writable; written: () => string } {
  const chunks: Buffer[] = [];
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  return { stream: w, written: () => Buffer.concat(chunks).toString("utf8") };
}

describe("pickFromList (numbered fallback)", () => {
  test("auto-selects when only one item", async () => {
    const out = bufferingWritable();
    const selected = await pickFromList([{ id: "only" }], {
      format: (x) => x.id,
      input: stringStream(""),
      output: out.stream,
      backend: "numbered",
    });
    expect(selected?.id).toBe("only");
  });

  test("returns null on empty list", async () => {
    const selected = await pickFromList([], {
      format: () => "",
      input: stringStream(""),
      output: new PassThrough(),
      backend: "numbered",
    });
    expect(selected).toBeNull();
  });

  test("parses numeric selection", async () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const out = bufferingWritable();
    const selected = await pickFromList(items, {
      format: (x) => x.id,
      input: stringStream("2\n"),
      output: out.stream,
      backend: "numbered",
    });
    expect(selected?.id).toBe("b");
    expect(out.written()).toContain("1) a");
    expect(out.written()).toContain("2) b");
  });

  test("returns null on empty input (cancel)", async () => {
    const items = [{ id: "a" }, { id: "b" }];
    const selected = await pickFromList(items, {
      format: (x) => x.id,
      input: stringStream("\n"),
      output: new PassThrough(),
      backend: "numbered",
    });
    expect(selected).toBeNull();
  });

  test("returns null on out-of-range selection", async () => {
    const items = [{ id: "a" }, { id: "b" }];
    const selected = await pickFromList(items, {
      format: (x) => x.id,
      input: stringStream("99\n"),
      output: new PassThrough(),
      backend: "numbered",
    });
    expect(selected).toBeNull();
  });
});

describe("pickMultipleFromList (numbered fallback)", () => {
  test("parses comma- and space-separated selections", async () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const out = bufferingWritable();
    const selected = await pickMultipleFromList(items, {
      format: (x) => x.id,
      input: stringStream("1, 3 4\n"),
      output: out.stream,
      backend: "numbered",
    });
    expect(selected?.map((i) => i.id)).toEqual(["a", "c", "d"]);
    expect(out.written()).toContain("comma- or space-separated");
  });

  test("returns null on out-of-range selection", async () => {
    const items = [{ id: "a" }, { id: "b" }];
    const selected = await pickMultipleFromList(items, {
      format: (x) => x.id,
      input: stringStream("1,99\n"),
      output: new PassThrough(),
      backend: "numbered",
    });
    expect(selected).toBeNull();
  });

  test("returns null on empty input (cancel)", async () => {
    const items = [{ id: "a" }, { id: "b" }];
    const selected = await pickMultipleFromList(items, {
      format: (x) => x.id,
      input: stringStream("\n"),
      output: new PassThrough(),
      backend: "numbered",
    });
    expect(selected).toBeNull();
  });
});

// Fast drop-in for csv-reader 1.0.0 (make.fun): same answers, faster.
// Single pass over the text with native indexOf/slice doing the scanning:
// unquoted fields are found by indexOf(',') / indexOf('\n') and sliced out
// whole; only fields that hold a stray CR, a quote, or junk after a closing
// quote fall back to a character loop. Quoted fields are found by an
// indexOf('"') walk that skips doubled quotes, and sliced out whole when
// they hold no escapes and no line breaks.
//
// Semantics (csv-reader 1.0.0, its own broken-row policy):
//  - U+FEFF at the very start is dropped; a record ends at LF or CRLF and a
//    line left with no characters is no record.
//  - Outside quotes a CR not followed by LF is dropped (stray_cr).
//  - A field that opens with a quote runs to the next quote that is not
//    doubled ("" inside is one quote; each CRLF or lone CR inside is read
//    as LF); what follows its closing quote up to the next comma or line
//    break is appended as it stands (quote_junk, when the field ends); a
//    quote that never closes is a literal character and the text after it
//    is read again as unquoted (unterminated_quote).
//  - A quote inside an unquoted field is a literal character. Fields stay
//    strings, never trimmed or converted.
//  - columns is the first record when header is true, else null; rows holds
//    the records after it, each padded (short_row, with fields: its count)
//    or cut (long_row, with extra: the cut fields) to the first record's
//    width. Each error is {code, line, row}, in the order met; line is the
//    1-based line its record starts on, row its index in rows (null for the
//    header).
// Pure: no clock, no randomness, nothing kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on, its index in rows (null:
  // the header). These are read by the error helpers below.
  let recordLine = 1;
  let recordRow = null;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field a character at a time, from `pos`, starting
  // with `value` already read and `added` kept characters in it. Used only
  // for fields that hold a stray CR, for junk after a closing quote, and
  // for the re-read after an unterminated quote: the rare paths.
  function readUnquotedSlow(value, added) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        pushError('stray_cr');
        pos += 1;
        continue;
      }
      value += text[pos];
      added += 1;
      pos += 1;
    }
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote, skipping doubled quotes.
    let q = pos + 1;
    let escaped = false;
    let close = -1;
    while (true) {
      const idx = text.indexOf('"', q);
      if (idx === -1) break;
      if (text.charCodeAt(idx + 1) === 34) {
        escaped = true;
        q = idx + 2;
        continue;
      }
      close = idx;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      pushError('unterminated_quote');
      return readUnquotedSlow('"', 1);
    }
    const raw = text.slice(open + 1, close);
    let value = raw;
    const hasNL = raw.indexOf('\n') !== -1 || raw.indexOf('\r') !== -1;
    if (escaped || hasNL) {
      if (escaped) value = value.replaceAll('""', '"');
      // Count the line breaks inside the quotes, then read each CRLF or
      // lone CR inside as one LF.
      if (hasNL) {
        for (let i = 0; i < value.length; i++) {
          const c = value.charCodeAt(i);
          if (c === 10) {
            line += 1;
          } else if (c === 13) {
            line += 1;
            if (value.charCodeAt(i + 1) === 10) i += 1;
          }
        }
        if (value.indexOf('\r') !== -1) value = value.replace(/\r\n?/g, '\n');
      }
    }
    pos = close + 1;
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquotedSlow(value, value.length);
    if (junk.added > value.length) pushError('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      let value;
      if (quoted) {
        const f = readQuoted();
        value = f.value;
        ended = f.ended;
      } else {
        // Fast path: the field ends at the next comma, unless a line break
        // comes first. indexOf(',') stops at the comma; a line break
        // before it can only sit inside the sliced field, so it is found
        // by scanning that short slice, never by scanning to the end of
        // the line. The last field of a record (no comma left) is found
        // by one indexOf('\n') per record.
        const cIdx = text.indexOf(',', pos);
        if (cIdx !== -1) {
          const v = text.slice(pos, cIdx);
          const nl = v.indexOf('\n');
          if (nl === -1) {
            if (v.indexOf('\r') === -1) {
              pos = cIdx + 1;
              value = v;
              ended = COMMA;
            } else {
              const f = readUnquotedSlow('', 0);
              value = f.value;
              ended = f.ended;
            }
          } else {
            let end = pos + nl;
            if (end > pos && text.charCodeAt(end - 1) === 13) end -= 1;
            const v2 = text.slice(pos, end);
            if (v2.indexOf('\r') === -1) {
              pos = pos + nl + 1;
              line += 1;
              value = v2;
              ended = LINE_BREAK;
            } else {
              const f = readUnquotedSlow('', 0);
              value = f.value;
              ended = f.ended;
            }
          }
        } else {
          const nIdx = text.indexOf('\n', pos);
          if (nIdx !== -1) {
            let end = nIdx;
            if (nIdx > pos && text.charCodeAt(nIdx - 1) === 13) end = nIdx - 1;
            const v = text.slice(pos, end);
            if (v.indexOf('\r') === -1) {
              pos = nIdx + 1;
              line += 1;
              value = v;
              ended = LINE_BREAK;
            } else {
              const f = readUnquotedSlow('', 0);
              value = f.value;
              ended = f.ended;
            }
          } else {
            const v = text.slice(pos);
            if (v.indexOf('\r') === -1) {
              pos = n;
              value = v;
              ended = END;
            } else {
              const f = readUnquotedSlow('', 0);
              value = f.value;
              ended = f.ended;
            }
          }
        }
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

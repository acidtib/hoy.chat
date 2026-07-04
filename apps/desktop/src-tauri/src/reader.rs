// Strict JSONL framing for Pi's RPC stream. Mirrors Pi's own jsonl.js:
// records are delimited by LF only; a trailing CR is stripped. U+2028 and
// U+2029 are valid inside JSON string values and must NOT split a record, so
// we scan for b'\n' over raw bytes and never decode-then-split. Do not replace
// this with a Unicode-aware line reader (Node readline, str::lines on a decoded
// stream that a Unicode-aware source produced, etc.).

pub struct JsonlFramer {
    buf: Vec<u8>,
}

impl JsonlFramer {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    // Feed a raw chunk; return every complete record it completes. Records are
    // returned without the trailing LF and without a trailing CR. Empty lines
    // are skipped.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        // Scan forward over the buffer, advancing `start` past each record, then
        // drain the consumed prefix once. Draining per record instead would
        // re-shift the trailing bytes on every iteration (quadratic on a chunk
        // that completes many small records).
        let mut start = 0;
        while let Some(rel) = self.buf[start..].iter().position(|&b| b == b'\n') {
            let end = start + rel; // index of the LF
            let mut line = &self.buf[start..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            if !line.is_empty() {
                out.push(String::from_utf8_lossy(line).into_owned());
            }
            start = end + 1;
        }
        if start > 0 {
            self.buf.drain(..start);
        }
        out
    }
}

impl Default for JsonlFramer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The landmine: U+2028 inside a JSON string value must stay inside its
    // record. A reader that treats U+2028 as a line separator would split this
    // single record into two and corrupt the JSON.
    #[test]
    fn u2028_inside_string_does_not_split() {
        let mut f = JsonlFramer::new();
        let rec1 = "{\"kind\":\"text\",\"delta\":\"line one\u{2028}still line one\"}";
        let rec2 = "{\"kind\":\"done\"}";
        let input = format!("{rec1}\n{rec2}\n");

        let records = f.push(input.as_bytes());

        assert_eq!(records.len(), 2, "expected exactly two records");
        assert_eq!(records[0], rec1);
        assert!(records[0].contains('\u{2028}'));
        assert_eq!(records[1], rec2);
        // The record is still valid JSON with the separator preserved in-string.
        let v: serde_json::Value = serde_json::from_str(&records[0]).unwrap();
        assert_eq!(v["delta"], "line one\u{2028}still line one");
    }

    #[test]
    fn u2029_inside_string_does_not_split() {
        let mut f = JsonlFramer::new();
        let rec = "{\"delta\":\"a\u{2029}b\"}";
        let records = f.push(format!("{rec}\n").as_bytes());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0], rec);
    }

    #[test]
    fn strips_trailing_cr() {
        let mut f = JsonlFramer::new();
        let records = f.push(b"{\"a\":1}\r\n");
        assert_eq!(records, vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn reassembles_records_split_across_chunks() {
        let mut f = JsonlFramer::new();
        assert!(f.push(b"{\"a\":").is_empty());
        assert!(f.push(b"1}").is_empty(), "no newline yet, nothing emitted");
        let records = f.push(b"\n{\"b\":2}\n");
        assert_eq!(
            records,
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
    }

    #[test]
    fn skips_empty_lines() {
        let mut f = JsonlFramer::new();
        let records = f.push(b"\n{\"a\":1}\n\n");
        assert_eq!(records, vec!["{\"a\":1}".to_string()]);
    }
}

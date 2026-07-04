// Sidecar-free transcript read (HOY-287). Reopening a persisted thread used to
// show nothing until a fresh sidecar spawned and answered get_messages (>2.5s).
// This module parses a thread's session JSONL straight off disk so the renderer
// can paint the transcript instantly, then reconcile with the live get_messages
// once the sidecar is up.
//
// The on-disk file is Pi's append-only session log: one JSON object per line,
// each an entry with a `type` discriminant. We only need the linear conversation
// path the sidecar's get_messages returns, which is the AgentMessage carried by
// every `{"type":"message"}` entry on the current leaf's parent chain. Non-message
// entries (session header, model_change, thinking_level_change, ...) participate
// in the id/parentId chain but carry no message; abandoned fork branches are off
// the leaf's chain and are correctly excluded.
//
// Output matches commands::get_messages exactly: a Vec<serde_json::Value>, each
// element the inner `message` object (Pi's opaque AgentMessage). The renderer
// folds both into turns via the same messagesToTurns path, so a disk read and a
// sidecar read render identically.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::pi_config;

// Read a thread's transcript directly from its session JSONL, returning the same
// Vec<AgentMessage> shape as commands::get_messages. `session_file` is the
// absolute path stored on the thread (thread.sessionFile), the same value
// create_session/delete_session_file take. Guarded to the branded sessions dir so
// a stray path can never read arbitrary files. A missing file reads as an empty
// transcript (a thread whose sidecar has not written a session yet).
pub fn read_transcript(session_file: &str) -> Result<Vec<Value>, String> {
    let sessions_root = pi_config::agent_dir()?.join("sessions");
    let path = PathBuf::from(session_file);
    // starts_with is component-wise, so a `..` component would pass the prefix
    // check while resolving outside the sessions dir. Reject any traversal
    // (mirrors delete_session_file's guard).
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
        || !path.starts_with(&sessions_root)
    {
        return Err("refusing to read outside the sessions dir".into());
    }
    read_transcript_at(&path)
}

// Path-resolved read, split out so the guard is testable without the branded dir.
fn read_transcript_at(path: &Path) -> Result<Vec<Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(messages_from_jsonl(&contents)),
        // No session written yet is a legitimate empty transcript, not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read session file: {e}")),
    }
}

// Fold a session JSONL into the AgentMessage list get_messages yields. Pure over
// the file contents so it unit-tests in isolation.
//
// Walks the current leaf's parent chain rather than filtering in file order so a
// branched/forked session yields only the active path (the same path Pi resolves
// server-side), never entries from an abandoned branch. The leaf is the last
// valid entry that carries an id (Pi appends the current leaf); the chain is
// followed back through parentId to the root, then reversed to chronological
// order and reduced to each `message` entry's inner AgentMessage.
//
// Robust to a partially written or corrupt log: a line that is not valid JSON, or
// an entry missing its id, is skipped rather than aborting the read — an instant
// best-effort render that the sidecar reconcile will replace regardless.
pub fn messages_from_jsonl(contents: &str) -> Vec<Value> {
    let mut by_id: HashMap<String, Value> = HashMap::new();
    let mut leaf_id: Option<String> = None;

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue; // skip a malformed/partial line, keep reading
        };
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue; // an entry with no id cannot join the parent chain
        };
        let id = id.to_string();
        // The last entry with an id is the current leaf.
        leaf_id = Some(id.clone());
        by_id.insert(id, entry);
    }

    // Follow parentId from the leaf back to the root, guarding against a cycle or
    // a broken link (best-effort: stop rather than loop or panic).
    let mut chain: Vec<&Value> = Vec::new();
    let mut cursor = leaf_id;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    while let Some(id) = cursor {
        if !seen.insert(id.clone()) {
            break; // cycle guard
        }
        let Some(entry) = by_id.get(&id) else {
            break; // dangling parentId
        };
        chain.push(entry);
        cursor = entry
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_string);
    }

    // chain is leaf -> root; reverse to chronological order, then keep each
    // message entry's inner AgentMessage (the exact get_messages element shape).
    chain
        .into_iter()
        .rev()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|entry| entry.get("message").cloned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // A representative linear session: session header, model/thinking changes, then
    // a user -> assistant(toolCall) -> toolResult -> assistant(text) exchange. The
    // parser must return exactly the four `message` entries' inner objects, in
    // order, and drop the non-message entries.
    const LINEAR: &str = concat!(
        r#"{"type":"session","version":3,"id":"sess","timestamp":"t","cwd":"/x"}"#,
        "\n",
        r#"{"type":"model_change","id":"m1","parentId":null,"provider":"deepseek","modelId":"v4"}"#,
        "\n",
        r#"{"type":"thinking_level_change","id":"t1","parentId":"m1","thinkingLevel":"high"}"#,
        "\n",
        r#"{"type":"message","id":"u1","parentId":"t1","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        "\n",
        r#"{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"toolCall","id":"call1","name":"bash","arguments":{"command":"echo hi"}}],"stopReason":"toolUse"}}"#,
        "\n",
        r#"{"type":"message","id":"r1","parentId":"a1","message":{"role":"toolResult","toolCallId":"call1","toolName":"bash","content":[{"type":"text","text":"hi\n"}],"isError":false}}"#,
        "\n",
        r#"{"type":"message","id":"a2","parentId":"r1","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"stopReason":"stop"}}"#,
        "\n",
    );

    #[test]
    fn extracts_inner_messages_in_order_dropping_non_message_entries() {
        let msgs = messages_from_jsonl(LINEAR);
        assert_eq!(
            msgs.len(),
            4,
            "session/model/thinking entries must be dropped"
        );
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"][0]["text"], "hi");
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"][0]["type"], "toolCall");
        assert_eq!(msgs[1]["stopReason"], "toolUse");
        assert_eq!(msgs[2]["role"], "toolResult");
        assert_eq!(msgs[2]["toolCallId"], "call1");
        assert_eq!(msgs[3]["role"], "assistant");
        assert_eq!(msgs[3]["content"][0]["text"], "Done.");
    }

    #[test]
    fn empty_input_is_empty_transcript() {
        assert!(messages_from_jsonl("").is_empty());
        assert!(messages_from_jsonl("\n\n  \n").is_empty());
    }

    #[test]
    fn skips_malformed_and_partial_lines() {
        // A truncated final line (interrupted write) and a garbage line must not
        // abort the read; the well-formed messages still come through.
        let input = concat!(
            r#"{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"hi"}}"#,
            "\n",
            "this is not json\n",
            r#"{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":"ok"}}"#,
            "\n",
            r#"{"type":"message","id":"partial","parentId":"a1","messa"#, // truncated, no newline
        );
        let msgs = messages_from_jsonl(input);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[1]["role"], "assistant");
    }

    #[test]
    fn a_message_entry_without_inner_message_is_skipped() {
        let input = concat!(
            r#"{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"hi"}}"#,
            "\n",
            r#"{"type":"message","id":"bad","parentId":"u1"}"#, // no inner message field
            "\n",
        );
        let msgs = messages_from_jsonl(input);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
    }

    #[test]
    fn follows_leaf_chain_and_excludes_abandoned_fork_branch() {
        // u1 -> a1, then the conversation forks: a1 has two children. b_old is an
        // abandoned branch; the leaf (last written) is on the b_new branch, so only
        // the b_new path must appear.
        let input = concat!(
            r#"{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"root"}}"#,
            "\n",
            r#"{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":"first"}}"#,
            "\n",
            r#"{"type":"message","id":"b_old","parentId":"a1","message":{"role":"user","content":"abandoned"}}"#,
            "\n",
            r#"{"type":"message","id":"b_new","parentId":"a1","message":{"role":"user","content":"kept"}}"#,
            "\n",
        );
        let msgs = messages_from_jsonl(input);
        // Leaf is b_new (last entry). Path: u1 -> a1 -> b_new. b_old is off-path.
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["content"], "root");
        assert_eq!(msgs[1]["content"], "first");
        assert_eq!(msgs[2]["content"], "kept");
    }

    #[test]
    fn tolerates_a_broken_parent_link() {
        // The leaf's parentId points at an id that was never written; the walk
        // stops at the leaf rather than looping or panicking.
        let input = concat!(
            r#"{"type":"message","id":"orphan","parentId":"missing","message":{"role":"user","content":"lonely"}}"#,
            "\n",
        );
        let msgs = messages_from_jsonl(input);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["content"], "lonely");
    }

    #[test]
    fn missing_file_reads_as_empty_transcript() {
        let path = std::env::temp_dir().join(format!(
            "hoy-transcript-missing-{}.jsonl",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        assert!(read_transcript_at(&path).unwrap().is_empty());
    }

    #[test]
    fn reads_a_file_from_disk() {
        let path =
            std::env::temp_dir().join(format!("hoy-transcript-read-{}.jsonl", std::process::id()));
        std::fs::write(&path, LINEAR).unwrap();
        let msgs = read_transcript_at(&path).unwrap();
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0]["role"], "user");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_transcript_rejects_path_outside_sessions_dir() {
        // The public entry point must refuse a traversal path regardless of the
        // resolved sessions root.
        assert!(read_transcript("/etc/passwd").is_err());
        assert!(read_transcript("../../secret.jsonl").is_err());
    }
}

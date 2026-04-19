package nativeinput

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"cyrenecode/v2/internal/app"
	tea "github.com/charmbracelet/bubbletea"
)

type testSink struct {
	mu   sync.Mutex
	msgs []tea.Msg
}

func (s *testSink) Send(msg tea.Msg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.msgs = append(s.msgs, msg)
}

func (s *testSink) snapshot() []tea.Msg {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]tea.Msg, len(s.msgs))
	copy(out, s.msgs)
	return out
}

func TestDecodeEvent(t *testing.T) {
	msg, ok, err := DecodeEvent([]byte(`{"type":"composition_update","text":"zhong","cursor":2}`))
	if err != nil {
		t.Fatalf("DecodeEvent returned error: %v", err)
	}
	if !ok {
		t.Fatalf("expected composition event recognized")
	}
	update, ok := msg.(app.ComposerCompositionMsg)
	if !ok {
		t.Fatalf("expected composition update msg, got %T", msg)
	}
	if string(update.Text) != "zhong" || update.Cursor != 2 {
		t.Fatalf("unexpected decoded msg: %#v", update)
	}
}

func TestDecodeKeyEvent(t *testing.T) {
	msg, ok, err := DecodeEvent([]byte(`{"type":"key","key":"up"}`))
	if err != nil {
		t.Fatalf("DecodeEvent returned error: %v", err)
	}
	if !ok {
		t.Fatalf("expected key event recognized")
	}
	key, ok := msg.(tea.KeyMsg)
	if !ok {
		t.Fatalf("expected tea.KeyMsg, got %T", msg)
	}
	if key.Type != tea.KeyUp {
		t.Fatalf("expected key up, got %#v", key)
	}
}

func TestAvailableDetectsEnvBridge(t *testing.T) {
	t.Setenv("CYRENE_NATIVE_INPUT_BRIDGE_PATH", "/bin/sh")
	t.Setenv("CYRENE_NATIVE_INPUT_BRIDGE_ARGS", "-c true")
	if !Available() {
		t.Fatalf("expected Available to detect env-configured bridge")
	}
}

func TestAvailableDetectsWorkingDirectoryHelper(t *testing.T) {
	tempDir := t.TempDir()
	helperPath := filepath.Join(tempDir, "cyrene-ime-bridge.exe")
	if err := os.WriteFile(helperPath, []byte("stub"), 0o755); err != nil {
		t.Fatalf("WriteFile helper: %v", err)
	}
	previousWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatalf("Chdir tempDir: %v", err)
	}
	defer func() {
		_ = os.Chdir(previousWD)
	}()
	if !Available() {
		t.Fatalf("expected Available to detect helper in working directory")
	}
}

func TestBridgePumpsCompositionEventsIntoSink(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("shell helper unavailable on this platform")
	}
	scriptPath := filepath.Join(t.TempDir(), "native-input-helper.sh")
	script := "#!/bin/sh\n" +
		"printf '%s\\n' '{\"type\":\"composition_update\",\"text\":\"zhong\",\"cursor\":2}'\n" +
		"printf '%s\\n' '{\"type\":\"composition_commit\",\"text\":\"中\"}'\n" +
		"printf '%s\\n' '{\"type\":\"composition_clear\"}'\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("WriteFile helper script: %v", err)
	}
	t.Setenv("CYRENE_NATIVE_INPUT_BRIDGE_PATH", "/bin/sh")
	t.Setenv("CYRENE_NATIVE_INPUT_BRIDGE_ARGS", scriptPath)

	sink := &testSink{}
	bridge, ok, err := Start(sink, os.Stderr)
	if err != nil {
		t.Fatalf("Start returned error: %v", err)
	}
	if !ok {
		t.Fatalf("expected native input bridge to be detected")
	}
	defer func() { _ = bridge.Close() }()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		msgs := sink.snapshot()
		if len(msgs) >= 3 {
			update, ok := msgs[0].(app.ComposerCompositionMsg)
			if !ok || string(update.Text) != "zhong" || update.Cursor != 2 {
				t.Fatalf("unexpected first message: %#v", msgs[0])
			}
			commit, ok := msgs[1].(app.ComposerCompositionCommitMsg)
			if !ok || string(commit.Text) != "中" {
				t.Fatalf("unexpected second message: %#v", msgs[1])
			}
			if _, ok := msgs[2].(app.ComposerCompositionClearMsg); !ok {
				t.Fatalf("unexpected third message: %#v", msgs[2])
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("expected bridge messages, got %#v", sink.snapshot())
}

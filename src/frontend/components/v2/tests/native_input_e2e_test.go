package tests

import (
	"strings"
	"testing"

	"cyrenecode/v2/internal/app"
	"cyrenecode/v2/internal/nativeinput"
	tea "github.com/charmbracelet/bubbletea"
)

func TestNativeInputBridgeCompositionFlowRendersAndCommitsChinese(t *testing.T) {
	model := app.NewModel()
	model.Width = 80
	model.Update(nativeinputMustDecode(t, `{"type":"composition_update","text":"zhong","cursor":2}`))

	rendered := model.RenderComposerForTest(40)
	if !strings.Contains(rendered, "zh|ong") {
		t.Fatalf("expected inline composition render, got %q", rendered)
	}

	model.Update(nativeinputMustDecode(t, `{"type":"composition_commit","text":"中"}`))
	model.Update(nativeinputMustDecode(t, `{"type":"composition_clear"}`))

	if got := string(model.Input); got != "中" {
		t.Fatalf("expected committed chinese rune in composer, got %q", got)
	}
	if len(model.Composition) != 0 {
		t.Fatalf("expected composition cleared after commit, got %q", string(model.Composition))
	}
}

func nativeinputMustDecode(t *testing.T, payload string) tea.Msg {
	t.Helper()
	msg, ok, err := nativeinput.DecodeEvent([]byte(payload))
	if err != nil {
		t.Fatalf("DecodeEvent returned error: %v", err)
	}
	if !ok {
		t.Fatalf("expected payload to decode into native input event: %s", payload)
	}
	return msg
}

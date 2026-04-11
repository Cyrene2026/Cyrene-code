package tests

import (
	"strings"
	"testing"

	"cyrenecode/v2/internal/app"
	tea "github.com/charmbracelet/bubbletea"
)

func TestSubmitWithoutBridgeShowsErrorNotice(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("ship it")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if model.Status != app.StatusError {
		t.Fatalf("expected error status, got %q", model.Status)
	}

	if !strings.Contains(model.Notice, "Bridge not ready") {
		t.Fatalf("expected bridge error notice, got %q", model.Notice)
	}
}

func TestSlashHelpSetsNotice(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/help")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if !strings.Contains(model.Notice, "Command reference appended") {
		t.Fatalf("unexpected help notice: %q", model.Notice)
	}
	if len(model.Items) < 2 {
		t.Fatalf("expected help content appended to transcript")
	}
	helpText := model.Items[len(model.Items)-1].Text
	if !strings.Contains(helpText, "/provider profile") {
		t.Fatalf("expected provider profile commands in help text, got %q", helpText)
	}
	if !strings.Contains(helpText, "/mcp lsp bootstrap") {
		t.Fatalf("expected MCP LSP commands in help text, got %q", helpText)
	}
}

func TestWheelDownReturnsToLiveTail(t *testing.T) {
	model := app.NewModel()
	model.TranscriptOffset = 10

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonWheelDown,
		Action: tea.MouseActionPress,
	})

	if model.TranscriptOffset != 1 {
		t.Fatalf("expected transcript offset 1, got %d", model.TranscriptOffset)
	}
}

func TestSpaceInsertsIntoComposer(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hello")})
	model.Update(tea.KeyMsg{Type: tea.KeySpace})
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("world")})

	if got := string(model.Input); got != "hello world" {
		t.Fatalf("expected composer to contain space, got %q", got)
	}
}

func TestF6TogglesMouseCapture(t *testing.T) {
	model := app.NewModel()

	if !model.MouseCapture {
		t.Fatalf("expected mouse capture enabled by default")
	}

	model.Update(tea.KeyMsg{Type: tea.KeyF6})
	if model.MouseCapture {
		t.Fatalf("expected mouse capture disabled after f6")
	}

	model.Update(tea.KeyMsg{Type: tea.KeyF6})
	if !model.MouseCapture {
		t.Fatalf("expected mouse capture re-enabled after second f6")
	}
}

func TestWheelScrollMovesSessionSelectionWhenPanelOpen(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelSessions
	model.Sessions = []app.BridgeSession{
		{ID: "s1", Title: "one"},
		{ID: "s2", Title: "two"},
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonWheelDown,
		Action: tea.MouseActionPress,
	})

	if model.SessionIndex != 1 {
		t.Fatalf("expected session index 1, got %d", model.SessionIndex)
	}
}

func TestWheelScrollMovesApprovalPreviewWhenPanelOpen(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelApprovals
	model.PendingReviews = []app.BridgeReview{{
		ID:          "r-1",
		Action:      "edit_file",
		Path:        "a.txt",
		PreviewFull: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22",
	}}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonWheelDown,
		Action: tea.MouseActionPress,
	})

	if model.ApprovalPreviewOffset != 2 {
		t.Fatalf("expected approval preview offset 2, got %d", model.ApprovalPreviewOffset)
	}
}

func TestUnknownSlashCommandRequiresBridge(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/wat")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if !strings.Contains(model.Notice, "Bridge not ready") {
		t.Fatalf("expected bridge-required notice, got %q", model.Notice)
	}
}

func TestReviewCommandFocusesLatestPending(t *testing.T) {
	model := app.NewModel()
	model.PendingReviews = []app.BridgeReview{
		{ID: "r-1", Action: "edit_file", Path: "a.txt"},
		{ID: "r-2", Action: "run_command", Path: "."},
	}

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/review")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if model.ActivePanel != app.PanelApprovals {
		t.Fatalf("expected approvals panel opened, got %q", model.ActivePanel)
	}
	if model.ApprovalIndex != 1 {
		t.Fatalf("expected latest review selected, got %d", model.ApprovalIndex)
	}
	if model.ApprovalPreview != app.ApprovalFull {
		t.Fatalf("expected full preview mode, got %q", model.ApprovalPreview)
	}
}

func TestReviewCommandByIDOpensFullPreview(t *testing.T) {
	model := app.NewModel()
	model.PendingReviews = []app.BridgeReview{
		{ID: "r-1", Action: "edit_file", Path: "a.txt"},
		{ID: "r-2", Action: "run_command", Path: "."},
	}

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/review r-1")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if model.ActivePanel != app.PanelApprovals {
		t.Fatalf("expected approvals panel opened, got %q", model.ActivePanel)
	}
	if model.ApprovalIndex != 0 {
		t.Fatalf("expected selected index 0, got %d", model.ApprovalIndex)
	}
	if model.ApprovalPreview != app.ApprovalFull {
		t.Fatalf("expected full preview mode, got %q", model.ApprovalPreview)
	}
}

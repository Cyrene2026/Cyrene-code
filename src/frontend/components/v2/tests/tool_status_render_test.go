package tests

import (
	"strings"
	"testing"

	"cyrenecode/v2/internal/app"
)

func TestToolStatusUsesGrayTranscriptColor(t *testing.T) {
	model := app.NewModel()
	model.Status = app.StatusIdle
	model.Items = []app.Message{
		{Role: "system", Kind: "tool_status", Text: "Running list_dir | workspace..."},
	}

	rendered := model.RenderTranscriptForTest(56, 2)

	if !strings.Contains(rendered, "Running list_dir | workspace...") {
		t.Fatalf("expected tool status text preserved, got %q", rendered)
	}
	if !strings.Contains(rendered, "38;2;139;148;158") {
		t.Fatalf("expected gray ANSI foreground for tool status, got %q", rendered)
	}
}

func TestLatestRunningToolStatusShowsSpinner(t *testing.T) {
	model := app.NewModel()
	model.Status = app.StatusRequesting
	model.SpinnerFrame = 3
	model.Items = []app.Message{
		{Role: "system", Kind: "tool_status", Text: "Running list_dir | workspace..."},
	}

	rendered := model.RenderTranscriptForTest(64, 2)

	if !strings.Contains(rendered, "⠸ Calling tool: list_dir | workspace...") {
		t.Fatalf("expected animated tool-call spinner line, got %q", rendered)
	}
}

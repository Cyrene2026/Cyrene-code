package tests

import (
	"regexp"
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

func TestToolStatusDiffStatsRendersAsColoredSummary(t *testing.T) {
	model := app.NewModel()
	model.Status = app.StatusIdle
	model.Items = []app.Message{
		{Role: "system", Kind: "tool_status", Text: "diff_stats: +311 -140"},
	}

	rendered := model.RenderTranscriptForTest(32, 2)
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	plain := stripANSI.ReplaceAllString(rendered, "")

	if strings.Contains(plain, "diff_stats:") {
		t.Fatalf("expected diff_stats label hidden in transcript, got %q", plain)
	}
	if !strings.Contains(plain, "diff: +311 -140") {
		t.Fatalf("expected compact diff summary preserved, got %q", plain)
	}
	if !strings.Contains(rendered, "38;2;126;231;135") {
		t.Fatalf("expected green add marker, got %q", rendered)
	}
	if !strings.Contains(rendered, "38;2;255;161;152") {
		t.Fatalf("expected red remove marker, got %q", rendered)
	}
}

func TestToolStatusConfirmedWriteFileCollapsesToPathAndDiffOnly(t *testing.T) {
	model := app.NewModel()
	model.Status = app.StatusIdle
	model.Items = []app.Message{
		{Role: "system", Kind: "tool_status", Text: strings.Join([]string{
			"Tool: write_file simplex.py",
			"Wrote file: simplex.py",
			"[confirmed file mutation] write_file simplex.py",
			"postcondition: file content was overwritten successfully",
			"bytes_before: 4710",
			"bytes_after: 11271",
			"lines_before: 145",
			"lines_after: 316",
			"diff_stats: +311 -140",
		}, "\n")},
	}

	rendered := model.RenderTranscriptForTest(48, 4)
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	plain := stripANSI.ReplaceAllString(rendered, "")

	if !strings.Contains(plain, "simplex.py") {
		t.Fatalf("expected file path preserved, got %q", plain)
	}
	if !strings.Contains(plain, "diff: +311 -140") {
		t.Fatalf("expected diff summary preserved, got %q", plain)
	}
	for _, hidden := range []string{
		"Tool: write_file",
		"Wrote file:",
		"[confirmed file mutation]",
		"postcondition:",
		"bytes_before:",
		"bytes_after:",
		"lines_before:",
		"lines_after:",
		"diff_stats:",
	} {
		if strings.Contains(plain, hidden) {
			t.Fatalf("expected %q to be hidden, got %q", hidden, plain)
		}
	}
}

func TestReviewStatusConfirmedApplyPatchCollapsesMutationReceipt(t *testing.T) {
	model := app.NewModel()
	model.Status = app.StatusIdle
	model.Items = []app.Message{
		{Role: "system", Kind: "review_status", Text: strings.Join([]string{
			"Approved rev-1",
			"[confirmed file mutation] apply_patch simplex.py",
			"postcondition: patch was applied successfully and file content was updated",
			"bytes_before: 11271",
			"bytes_after: 11319",
			"lines_before: 316",
			"lines_after: 317",
		}, "\n")},
	}

	rendered := model.RenderTranscriptForTest(48, 4)
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	plain := stripANSI.ReplaceAllString(rendered, "")

	if !strings.Contains(plain, "simplex.py") {
		t.Fatalf("expected patched file path preserved, got %q", plain)
	}
	for _, hidden := range []string{
		"[confirmed file mutation]",
		"postcondition:",
		"bytes_before:",
		"bytes_after:",
		"lines_before:",
		"lines_after:",
	} {
		if strings.Contains(plain, hidden) {
			t.Fatalf("expected %q to be hidden, got %q", hidden, plain)
		}
	}
}

package tests

import (
	"regexp"
	"strings"
	"testing"

	"cyrenecode/v2/internal/app"
)

func TestToolStatusUsesNeutralColorForUnknownActions(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Status = app.StatusIdle
	model.Items = []app.Message{
		{Role: "system", Kind: "tool_status", Text: "Tool: mystery_tool foo | waiting"},
	}

	rendered := model.RenderTranscriptForTest(56, 2)
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	plain := stripANSI.ReplaceAllString(rendered, "")

	if !strings.Contains(plain, "Tool: mystery_tool foo | waiting") {
		t.Fatalf("expected tool status text preserved, got %q", rendered)
	}
	if !strings.Contains(rendered, "38;2;139;147;158") {
		t.Fatalf("expected neutral ANSI foreground for unknown tool status, got %q", rendered)
	}
}

func TestToolStatusUsesExploreColorForListDir(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Status = app.StatusIdle
	model.Items = []app.Message{
		{Role: "system", Kind: "tool_status", Text: "Running list_dir | workspace..."},
	}

	rendered := model.RenderTranscriptForTest(56, 2)
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	plain := stripANSI.ReplaceAllString(rendered, "")

	if !strings.Contains(plain, "Running list_dir | workspace...") {
		t.Fatalf("expected list_dir status preserved, got %q", rendered)
	}
	if !strings.Contains(rendered, "38;2;227;179;65") {
		t.Fatalf("expected explore ANSI foreground for list_dir, got %q", rendered)
	}
}

func TestToolStatusUsesSemanticColorForCompactedAliases(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Status = app.StatusIdle
	model.Items = []app.Message{
		{Role: "system", Kind: "tool_status", Text: "Tool error: lspdocumentsymbols src/entrypoints/cli.tsx | LSP config error"},
	}

	rendered := model.RenderTranscriptForTest(120, 2)
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	plain := stripANSI.ReplaceAllString(rendered, "")

	if strings.Contains(plain, "lspdocumentsymbols") {
		t.Fatalf("expected compact lsp alias canonicalized, got %q", plain)
	}
	if !strings.Contains(plain, "Tool error: lsp_document_symbols src/entrypoints/cli.tsx | LSP config error") {
		t.Fatalf("expected tool error text preserved, got %q", rendered)
	}
	if !strings.Contains(rendered, "38;2;94;215;200") {
		t.Fatalf("expected semantic ANSI foreground for lsp compact alias, got %q", rendered)
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

func TestToolStatusNormalizesCompactedToolNamesForDisplay(t *testing.T) {
	model := app.NewModel()
	model.Status = app.StatusIdle
	model.Items = []app.Message{
		{Role: "system", Kind: "tool_status", Text: "Running outlinefile | agent/promptbuilder.py..."},
		{Role: "system", Kind: "tool_status", Text: "Tool: readrange agent/promptbuilder.py | range content hidden"},
		{Role: "system", Kind: "tool_status", Text: strings.Join([]string{
			"Tool: readrange agent/context.py | range content hidden",
			"Tool: outlinefile cli.py | Outline for cli.py",
		}, "\n")},
		{Role: "system", Kind: "system_hint", Text: "Tool: readrange agent/promptbuilder.py | range content hidden"},
		{Role: "assistant", Kind: "transcript", Text: strings.Join([]string{
			"❯ Tool: outlinefile agent/promptbuilder.py | Outline for agent/prompt_builder.py",
			"❯ Tool: readrange agent/promptbuilder.py | range content hidden",
			"Tool:readrange cli.py | range content hidden",
		}, "\n")},
	}

	rendered := model.RenderTranscriptForTest(112, 12)
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	plain := stripANSI.ReplaceAllString(rendered, "")

	if strings.Contains(plain, "outlinefile") || strings.Contains(plain, "readrange") {
		t.Fatalf("expected compact tool aliases canonicalized, got %q", plain)
	}
	if !strings.Contains(plain, "Running outline_file | agent/promptbuilder.py...") {
		t.Fatalf("expected running outline_file display, got %q", plain)
	}
	if !strings.Contains(plain, "Tool: read_range agent/promptbuilder.py | range content hidden") {
		t.Fatalf("expected read_range tool display, got %q", plain)
	}
	if !strings.Contains(plain, "Tool: read_range agent/context.py | range content hidden") ||
		!strings.Contains(plain, "Tool: outline_file cli.py | Outline for cli.py") {
		t.Fatalf("expected every tool line in a multi-line message canonicalized, got %q", plain)
	}
	if !strings.Contains(plain, "❯ Tool: outline_file agent/promptbuilder.py | Outline for agent/prompt_builder.py") ||
		!strings.Contains(plain, "❯ Tool: read_range agent/promptbuilder.py | range content hidden") ||
		!strings.Contains(plain, "Tool: read_range cli.py | range content hidden") {
		t.Fatalf("expected prompted and compact tool lines canonicalized, got %q", plain)
	}
}

func TestToolStatusDiffStatsRendersAsColoredSummary(t *testing.T) {
	enableColorRenderingForTest(t)

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
	enableColorRenderingForTest(t)

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
	if !strings.Contains(rendered, "38;2;126;231;135") {
		t.Fatalf("expected mutation ANSI foreground for write_file summary, got %q", rendered)
	}
}

func TestToolStatusConfirmedWriteFileShowsDiffPreviewWhenAvailable(t *testing.T) {
	enableColorRenderingForTest(t)

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
			"diff_stats: +48 -0",
			"[diff preview]",
			"+    1 | from typing import Sequence",
			"+    2 | ",
			"diff_preview_omitted: 46",
			"next: do not call read_file on this path just to confirm the write",
		}, "\n")},
	}

	rendered := model.RenderTranscriptForTest(64, 8)
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	plain := stripANSI.ReplaceAllString(rendered, "")

	if !strings.Contains(plain, "simplex.py") {
		t.Fatalf("expected file path preserved, got %q", plain)
	}
	if !strings.Contains(plain, "diff: +48 -0") {
		t.Fatalf("expected diff summary preserved, got %q", plain)
	}
	if !strings.Contains(plain, "+    1") || !strings.Contains(plain, "from typing import Sequence") {
		t.Fatalf("expected diff preview line rendered, got %q", plain)
	}
	if !strings.Contains(plain, "... 46 more changed line(s)") {
		t.Fatalf("expected omitted diff line count rendered, got %q", plain)
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
		"[diff preview]",
		"diff_preview_omitted:",
		"next:",
	} {
		if strings.Contains(plain, hidden) {
			t.Fatalf("expected %q to be hidden, got %q", hidden, plain)
		}
	}
	if !strings.Contains(rendered, "38;2;126;231;135;48;2;16;63;43") {
		t.Fatalf("expected added diff preview line rendered with diff colors, got %q", rendered)
	}
}

func TestToolStatusConfirmedWriteFileShowsMaskedDiffPreviewWhenAvailable(t *testing.T) {
	enableColorRenderingForTest(t)

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
			"diff_stats: +32 -16",
			"[diff preview]",
			"+***",
			"-***",
			"diff_preview_omitted: 12",
			"next: do not call read_file on this path just to confirm the write",
		}, "\n")},
	}

	rendered := model.RenderTranscriptForTest(48, 8)
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	plain := stripANSI.ReplaceAllString(rendered, "")

	if !strings.Contains(plain, "simplex.py") {
		t.Fatalf("expected file path preserved, got %q", plain)
	}
	if !strings.Contains(plain, "diff: +32 -16") {
		t.Fatalf("expected diff summary preserved, got %q", plain)
	}
	if !strings.Contains(plain, "+ ***") || !strings.Contains(plain, "- ***") {
		t.Fatalf("expected masked diff preview lines rendered, got %q", plain)
	}
	if !strings.Contains(plain, "... 12 more changed line(s)") {
		t.Fatalf("expected omitted diff line count rendered, got %q", plain)
	}
	if !strings.Contains(rendered, "38;2;126;231;135;48;2;16;63;43") {
		t.Fatalf("expected added masked diff line rendered with diff colors, got %q", rendered)
	}
	if !strings.Contains(rendered, "38;2;255;161;152;48;2;93;30;39") {
		t.Fatalf("expected removed masked diff line rendered with diff colors, got %q", rendered)
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

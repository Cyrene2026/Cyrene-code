package app

import (
	"os"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

func TestSyncProcessAppRoot(t *testing.T) {
	originalCwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	originalRoot := os.Getenv("CYRENE_ROOT")
	t.Cleanup(func() {
		_ = os.Chdir(originalCwd)
		if originalRoot == "" {
			_ = os.Unsetenv("CYRENE_ROOT")
		} else {
			_ = os.Setenv("CYRENE_ROOT", originalRoot)
		}
	})

	target := t.TempDir()
	if err := syncProcessAppRoot(target); err != nil {
		t.Fatalf("syncProcessAppRoot returned error: %v", err)
	}

	currentCwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd after sync: %v", err)
	}
	if currentCwd != target {
		t.Fatalf("cwd = %q, want %q", currentCwd, target)
	}
	if got := os.Getenv("CYRENE_ROOT"); got != target {
		t.Fatalf("CYRENE_ROOT = %q, want %q", got, target)
	}
}

func TestListIndexAtPanelLine(t *testing.T) {
	index, ok := listIndexAtPanelLine(8, 0, 4, 2, 2)
	if !ok || index != 0 {
		t.Fatalf("expected first visible item, got ok=%t index=%d", ok, index)
	}

	index, ok = listIndexAtPanelLine(8, 0, 4, 5, 2)
	if !ok || index != 1 {
		t.Fatalf("expected second visible item, got ok=%t index=%d", ok, index)
	}

	_, ok = listIndexAtPanelLine(8, 0, 4, 10, 2)
	if ok {
		t.Fatalf("expected click outside visible item rows to be ignored")
	}
}

func TestRenderTranscriptClampsTopOffsetToFullPage(t *testing.T) {
	model := NewModel()
	model.Width = 80
	model.Height = 12
	model.Items = []Message{
		{Role: "user", Kind: "transcript", Text: "one"},
		{Role: "assistant", Kind: "transcript", Text: "two"},
		{Role: "user", Kind: "transcript", Text: "three"},
	}
	model.TranscriptOffset = 999

	rendered := model.renderTranscript(80, 4)
	lines := strings.Split(rendered, "\n")
	if len(lines) != 4 {
		t.Fatalf("expected 4 lines, got %d", len(lines))
	}
	if strings.TrimSpace(lines[0]) == "" || strings.TrimSpace(lines[1]) == "" {
		t.Fatalf("expected top transcript page to stay filled, got %q", rendered)
	}
}

func TestClampTranscriptOffsetPreventsOverscrollAccumulation(t *testing.T) {
	model := NewModel()
	model.Width = 80
	model.Height = 12
	model.Items = []Message{
		{Role: "user", Kind: "transcript", Text: "one"},
		{Role: "assistant", Kind: "transcript", Text: "two"},
		{Role: "user", Kind: "transcript", Text: "three"},
		{Role: "assistant", Kind: "transcript", Text: "four"},
		{Role: "user", Kind: "transcript", Text: "five"},
	}

	for index := 0; index < 20; index++ {
		model.handleWheelScroll(-1)
	}
	maxOffset := model.TranscriptOffset
	if maxOffset <= 0 {
		t.Fatalf("expected positive max offset after scrolling up, got %d", maxOffset)
	}

	model.handleWheelScroll(1)
	if model.TranscriptOffset != maxInt(0, maxOffset-scrollStep) {
		t.Fatalf("expected single down scroll to reduce from clamped max offset, got %d from %d", model.TranscriptOffset, maxOffset)
	}
}

func TestRenderMarkdownBodyLinesHandlesInlineCodeAndFences(t *testing.T) {
	lines := renderMarkdownBodyLines("Use `python demo.py`\n```bash\npython demo.py\n```", 80, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")

	if strings.Contains(rendered, "`python demo.py`") {
		t.Fatalf("expected inline code markers to be rendered without raw backticks, got %q", rendered)
	}
	if strings.Contains(rendered, "```") {
		t.Fatalf("expected code fences to be rendered without raw triple backticks, got %q", rendered)
	}
	if !strings.Contains(rendered, "python demo.py") {
		t.Fatalf("expected code content to remain visible, got %q", rendered)
	}
}

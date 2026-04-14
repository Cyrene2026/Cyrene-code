package tests

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"cyrenecode/v2/internal/app"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

func TestSyncProcessAppRoot(t *testing.T) {
	originalCwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	originalRoot := os.Getenv("CYRENE_ROOT")
	target := t.TempDir()
	t.Cleanup(func() {
		_ = os.Chdir(originalCwd)
		if originalRoot == "" {
			_ = os.Unsetenv("CYRENE_ROOT")
		} else {
			_ = os.Setenv("CYRENE_ROOT", originalRoot)
		}
	})

	if err := app.SyncProcessAppRootForTest(target); err != nil {
		t.Fatalf("SyncProcessAppRootForTest returned error: %v", err)
	}

	currentCwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd after sync: %v", err)
	}
	if currentCwd != target {
		resolvedCwd, cwdErr := filepath.EvalSymlinks(currentCwd)
		resolvedTarget, targetErr := filepath.EvalSymlinks(target)
		if cwdErr != nil || targetErr != nil || resolvedCwd != resolvedTarget {
			t.Fatalf("cwd = %q, want %q", currentCwd, target)
		}
	}
	if got := os.Getenv("CYRENE_ROOT"); got != target {
		t.Fatalf("CYRENE_ROOT = %q, want %q", got, target)
	}
}

func TestListIndexAtPanelLine(t *testing.T) {
	index, ok := app.ListIndexAtPanelLineForTest(8, 0, 4, 2, 2, 2)
	if !ok || index != 0 {
		t.Fatalf("expected first visible item, got ok=%t index=%d", ok, index)
	}

	index, ok = app.ListIndexAtPanelLineForTest(8, 0, 4, 2, 5, 2)
	if !ok || index != 1 {
		t.Fatalf("expected second visible item, got ok=%t index=%d", ok, index)
	}

	_, ok = app.ListIndexAtPanelLineForTest(8, 0, 4, 2, 10, 2)
	if ok {
		t.Fatalf("expected click outside visible item rows to be ignored")
	}
}

func TestListIndexAtPanelLineSupportsThreeLineRows(t *testing.T) {
	index, ok := app.ListIndexAtPanelLineForTest(8, 0, 4, 3, 4, 2)
	if !ok || index != 0 {
		t.Fatalf("expected first three-line item, got ok=%t index=%d", ok, index)
	}

	index, ok = app.ListIndexAtPanelLineForTest(8, 0, 4, 3, 7, 2)
	if !ok || index != 1 {
		t.Fatalf("expected second three-line item, got ok=%t index=%d", ok, index)
	}
}

func TestRenderTranscriptClampsTopOffsetToFullPage(t *testing.T) {
	model := app.NewModel()
	model.Width = 80
	model.Height = 12
	model.Items = []app.Message{
		{Role: "user", Kind: "transcript", Text: "one"},
		{Role: "assistant", Kind: "transcript", Text: "two"},
		{Role: "user", Kind: "transcript", Text: "three"},
	}
	model.TranscriptOffset = 999

	rendered := model.RenderTranscriptForTest(80, 4)
	lines := strings.Split(rendered, "\n")
	if len(lines) != 4 {
		t.Fatalf("expected 4 lines, got %d", len(lines))
	}
	if strings.TrimSpace(lines[0]) == "" || strings.TrimSpace(lines[1]) == "" {
		t.Fatalf("expected top transcript page to stay filled, got %q", rendered)
	}
}

func TestClampTranscriptOffsetPreventsOverscrollAccumulation(t *testing.T) {
	model := app.NewModel()
	model.Width = 80
	model.Height = 12
	model.Items = []app.Message{
		{Role: "user", Kind: "transcript", Text: "one"},
		{Role: "assistant", Kind: "transcript", Text: "two"},
		{Role: "user", Kind: "transcript", Text: "three"},
		{Role: "assistant", Kind: "transcript", Text: "four"},
		{Role: "user", Kind: "transcript", Text: "five"},
		{Role: "assistant", Kind: "transcript", Text: "six"},
		{Role: "user", Kind: "transcript", Text: "seven"},
		{Role: "assistant", Kind: "transcript", Text: "eight"},
		{Role: "user", Kind: "transcript", Text: "nine"},
		{Role: "assistant", Kind: "transcript", Text: "ten"},
	}
	x, y, ok := model.TranscriptMousePointForTest()
	if !ok {
		t.Fatalf("expected transcript mouse point")
	}

	for range 20 {
		model.Update(tea.MouseMsg{
			Button: tea.MouseButtonWheelUp,
			Action: tea.MouseActionPress,
			X:      x,
			Y:      y,
		})
	}
	maxOffset := model.TranscriptOffset
	if maxOffset <= 0 {
		t.Fatalf("expected positive max offset after scrolling up, got %d", maxOffset)
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonWheelDown,
		Action: tea.MouseActionPress,
		X:      x,
		Y:      y,
	})
	if model.TranscriptOffset != max(0, maxOffset-8) {
		t.Fatalf("expected single down scroll to reduce from clamped max offset, got %d from %d", model.TranscriptOffset, maxOffset)
	}
}

func TestRenderMarkdownBodyLinesHandlesInlineCodeAndFences(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest("Use `python demo.py`\n```bash\npython demo.py\n```", 80, lipgloss.NewStyle())
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

func TestRenderMarkdownBodyLinesHandlesListsQuotesAndEmphasis(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest("1. **Bold** item\n- _Italic_ bullet\n> quote line", 80, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")

	if strings.Contains(rendered, "**Bold**") {
		t.Fatalf("expected bold markers removed, got %q", rendered)
	}
	if strings.Contains(rendered, "_Italic_") {
		t.Fatalf("expected italic markers removed, got %q", rendered)
	}
	if strings.Contains(rendered, "> quote line") {
		t.Fatalf("expected quote marker normalized, got %q", rendered)
	}
	if !strings.Contains(rendered, "1. ") || !strings.Contains(rendered, "• ") || !strings.Contains(rendered, "│ ") {
		t.Fatalf("expected list and quote prefixes rendered, got %q", rendered)
	}
}

func TestRenderMarkdownBodyLinesRendersTables(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest(
		"| Name | Value |\n| --- | --- |\n| Alpha | 123 |\n| Beta | 456 |",
		48,
		lipgloss.NewStyle(),
	)
	rendered := strings.Join(lines, "\n")

	if !strings.Contains(rendered, "┌") || !strings.Contains(rendered, "┬") || !strings.Contains(rendered, "└") {
		t.Fatalf("expected terminal table borders, got %q", rendered)
	}
	if !strings.Contains(rendered, "Name") || !strings.Contains(rendered, "Alpha") || !strings.Contains(rendered, "456") {
		t.Fatalf("expected table contents preserved, got %q", rendered)
	}
}

func TestRenderMarkdownBodyLinesClampsTableWidth(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest(
		"| Column A | Column B | Column C |\n| --- | --- | --- |\n| very long content here | another long cell | third long cell |",
		30,
		lipgloss.NewStyle(),
	)
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	for _, line := range lines {
		plain := stripANSI.ReplaceAllString(line, "")
		if lipgloss.Width(plain) > 30 {
			t.Fatalf("expected table row width <= 30, got %d for %q", lipgloss.Width(plain), plain)
		}
	}
}

func TestRenderTranscriptClampsStyledLinesToWidth(t *testing.T) {
	model := app.NewModel()
	model.Items = []app.Message{
		{Role: "assistant", Kind: "transcript", Text: strings.Repeat("宽", 40)},
		{Role: "system", Kind: "tool_status", Text: "Running read_file | " + strings.Repeat("src/very/long/path/", 8)},
	}

	rendered := model.RenderTranscriptForTest(24, 6)
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	for _, line := range strings.Split(rendered, "\n") {
		plain := stripANSI.ReplaceAllString(line, "")
		if lipgloss.Width(plain) > 24 {
			t.Fatalf("expected transcript line width <= 24, got %d for %q", lipgloss.Width(plain), plain)
		}
	}
}

func TestStartupLogoColorUsesDiagonalGradientAcrossProfiles(t *testing.T) {
	topLeft := app.StartupLogoColorForTest(0, 0, 6, 10)
	topRight := app.StartupLogoColorForTest(0, 9, 6, 10)
	bottomLeft := app.StartupLogoColorForTest(5, 0, 6, 10)
	bottomRight := app.StartupLogoColorForTest(5, 9, 6, 10)

	if topLeft.TrueColor != "#2F81FF" || topLeft.ANSI256 != "27" || topLeft.ANSI != "12" {
		t.Fatalf("unexpected top-left color: %+v", topLeft)
	}
	if bottomRight.TrueColor != "#A855F7" || bottomRight.ANSI256 != "135" || bottomRight.ANSI != "13" {
		t.Fatalf("unexpected bottom-right color: %+v", bottomRight)
	}
	if topRight != bottomLeft {
		t.Fatalf("expected equal colors on the same diagonal, got top-right=%+v bottom-left=%+v", topRight, bottomLeft)
	}
	if topLeft == bottomRight {
		t.Fatalf("expected diagonal endpoints to differ, got %+v and %+v", topLeft, bottomRight)
	}
}

func TestRenderStartupLogoLineAdaptsToTerminalProfiles(t *testing.T) {
	originalProfile := lipgloss.ColorProfile()
	t.Cleanup(func() {
		lipgloss.SetColorProfile(originalProfile)
	})

	lipgloss.SetColorProfile(termenv.TrueColor)
	trueColorLine := app.RenderStartupLogoLineForTest("AB", 0, 2, 2)
	if !strings.Contains(trueColorLine, "38;2;") {
		t.Fatalf("expected truecolor escape sequence, got %q", trueColorLine)
	}

	lipgloss.SetColorProfile(termenv.ANSI256)
	ansi256Line := app.RenderStartupLogoLineForTest("AB", 0, 2, 2)
	if !strings.Contains(ansi256Line, "38;5;") {
		t.Fatalf("expected ansi256 escape sequence, got %q", ansi256Line)
	}

	lipgloss.SetColorProfile(termenv.ANSI)
	ansiLine := app.RenderStartupLogoLineForTest("AB", 0, 2, 2)
	if strings.Contains(ansiLine, "\x1b[38;2;") || strings.Contains(ansiLine, "\x1b[38;5;") {
		t.Fatalf("expected ansi16 escape sequence, got %q", ansiLine)
	}
	if !strings.Contains(ansiLine, "94m") {
		t.Fatalf("expected bright blue ansi sequence, got %q", ansiLine)
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

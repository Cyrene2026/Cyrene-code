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
	if !strings.Contains(rendered, "one") || !strings.Contains(rendered, "two") {
		t.Fatalf("expected top transcript page to preserve visible transcript content, got %q", rendered)
	}
}

func TestUserTranscriptRendersFullWidthGrayBackgroundWithWhiteText(t *testing.T) {
	originalProfile := lipgloss.ColorProfile()
	t.Cleanup(func() {
		lipgloss.SetColorProfile(originalProfile)
	})
	lipgloss.SetColorProfile(termenv.TrueColor)

	model := app.NewModel()
	model.Items = []app.Message{
		{Role: "user", Kind: "transcript", Text: "不要调用工具，回答:已经看过的内容"},
	}

	rendered := model.RenderTranscriptForTest(48, 2)

	if !strings.Contains(rendered, "不要调用工具，回答:已经看过的内容") {
		t.Fatalf("expected user transcript text preserved, got %q", rendered)
	}
	if !strings.Contains(rendered, "\x1b[48;2;30;40;59m") {
		t.Fatalf("expected full-width user surface background ANSI, got %q", rendered)
	}
	if !strings.Contains(rendered, "38;2;230;237;243") {
		t.Fatalf("expected primary foreground ANSI for user transcript, got %q", rendered)
	}
}

func TestUserTranscriptGetsVerticalBreathingRoom(t *testing.T) {
	model := app.NewModel()
	model.Items = []app.Message{
		{Role: "assistant", Kind: "transcript", Text: "上一条回复"},
		{Role: "user", Kind: "transcript", Text: "这是用户输入"},
		{Role: "assistant", Kind: "transcript", Text: "这是 AI 回复"},
	}

	rendered := model.RenderTranscriptForTest(40, 8)
	lines := strings.Split(rendered, "\n")
	userLine := -1
	for index, line := range lines {
		if strings.Contains(line, "这是用户输入") {
			userLine = index
			break
		}
	}

	if userLine <= 0 || userLine+1 >= len(lines) {
		t.Fatalf("expected user transcript line in rendered output, got %q", rendered)
	}
	if strings.TrimSpace(lines[userLine-1]) != "" {
		t.Fatalf("expected blank line above user transcript, got %q", rendered)
	}
	if strings.TrimSpace(lines[userLine+1]) != "" {
		t.Fatalf("expected blank line below user transcript, got %q", rendered)
	}
}

func TestClampTranscriptOffsetPreventsOverscrollAccumulation(t *testing.T) {
	model := app.NewModel()
	model.Width = 40
	model.Height = 12
	model.Items = []app.Message{
		{Role: "user", Kind: "transcript", Text: strings.Repeat("one ", 12)},
		{Role: "assistant", Kind: "transcript", Text: strings.Repeat("two ", 12)},
		{Role: "user", Kind: "transcript", Text: strings.Repeat("three ", 12)},
		{Role: "assistant", Kind: "transcript", Text: strings.Repeat("four ", 12)},
		{Role: "user", Kind: "transcript", Text: strings.Repeat("five ", 12)},
		{Role: "assistant", Kind: "transcript", Text: strings.Repeat("six ", 12)},
		{Role: "user", Kind: "transcript", Text: strings.Repeat("seven ", 12)},
		{Role: "assistant", Kind: "transcript", Text: strings.Repeat("eight ", 12)},
		{Role: "user", Kind: "transcript", Text: strings.Repeat("nine ", 12)},
		{Role: "assistant", Kind: "transcript", Text: strings.Repeat("ten ", 12)},
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
	plain := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(rendered, "")

	if strings.Contains(rendered, "`python demo.py`") {
		t.Fatalf("expected inline code markers to be rendered without raw backticks, got %q", rendered)
	}
	if strings.Contains(rendered, "```") {
		t.Fatalf("expected code fences to be rendered without raw triple backticks, got %q", rendered)
	}
	if !strings.Contains(plain, "python demo.py") {
		t.Fatalf("expected code content to remain visible, got %q", rendered)
	}
	if !strings.Contains(plain, "╭ code bash ") || !strings.Contains(plain, "╰") {
		t.Fatalf("expected styled code block frame rendered, got %q", plain)
	}
	if !strings.Contains(plain, " 1│") {
		t.Fatalf("expected code block line number gutter rendered, got %q", plain)
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

func TestRenderMarkdownBodyLinesHandlesNestedListsAndTaskLists(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest("- [x] done\n  - [ ] todo\n    1. child", 80, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")
	plain := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(rendered, "")

	if strings.Contains(plain, "[x]") || strings.Contains(plain, "[ ]") {
		t.Fatalf("expected task list markers normalized, got %q", plain)
	}
	if !strings.Contains(plain, "☑") || !strings.Contains(plain, "☐") {
		t.Fatalf("expected rendered task list checkboxes, got %q", plain)
	}
	if !strings.Contains(plain, "◦") || !strings.Contains(plain, "1. ") {
		t.Fatalf("expected nested list prefixes preserved, got %q", plain)
	}
}

func TestRenderMarkdownBodyLinesDoesNotTreatIdentifierUnderscoresAsEmphasis(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest("Tool: outline_file agent/prompt_builder.py | Outline for agent/prompt_builder.py", 120, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")
	plain := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(rendered, "")

	if strings.Contains(plain, "outlinefile") || strings.Contains(plain, "promptbuilder") {
		t.Fatalf("expected identifier underscores preserved, got %q", plain)
	}
	if !strings.Contains(plain, "outline_file") || !strings.Contains(plain, "prompt_builder.py") {
		t.Fatalf("expected identifier underscores visible, got %q", plain)
	}
}

func TestRenderMarkdownBodyLinesHandlesSetextRulesAndTildeFences(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest("Main title\n---\n\n***\n~~~ts\nconst x = 1\n~~~", 80, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")
	plain := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(rendered, "")

	if strings.Contains(plain, "~~~") || strings.Contains(plain, "***") {
		t.Fatalf("expected fence and rule markers removed, got %q", plain)
	}
	if !strings.Contains(plain, "Main title") || !strings.Contains(plain, "const x = 1") {
		t.Fatalf("expected heading and code content preserved, got %q", plain)
	}
	if !strings.Contains(plain, "───") {
		t.Fatalf("expected horizontal rule rendered, got %q", plain)
	}
	if !strings.Contains(plain, "╭ code ts ") || !strings.Contains(plain, "const x = 1") {
		t.Fatalf("expected fenced code block promoted to framed renderer, got %q", plain)
	}
}

func TestRenderMarkdownBodyLinesKeepsCodeBlockFrameAcrossWrappedAndBlankLines(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest("```py\n\nprint('a very long line that should wrap inside the code block without breaking the frame')\n```", 54, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")
	plain := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(rendered, "")

	if !strings.Contains(plain, "╭ code py ") || !strings.Contains(plain, "╰") {
		t.Fatalf("expected code block frame preserved, got %q", plain)
	}
	if !strings.Contains(plain, " 1│") || !strings.Contains(plain, " 2│") {
		t.Fatalf("expected line number gutter for blank and content lines, got %q", plain)
	}
	if strings.Contains(plain, "```") {
		t.Fatalf("expected raw fence markers removed, got %q", plain)
	}
}

func TestRenderMarkdownCodeBlockDoesNotUseBackgroundFill(t *testing.T) {
	originalProfile := lipgloss.ColorProfile()
	t.Cleanup(func() {
		lipgloss.SetColorProfile(originalProfile)
	})
	lipgloss.SetColorProfile(termenv.TrueColor)

	lines := app.RenderMarkdownBodyLinesForTest("```py\nprint('x')\n```", 48, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")

	if strings.Contains(rendered, "48;2;13;17;23") {
		t.Fatalf("expected code block body background removed, got %q", rendered)
	}
	if strings.Contains(rendered, "48;2;23;34;53") || strings.Contains(rendered, "48;2;23;34;52") {
		t.Fatalf("expected code block header background removed, got %q", rendered)
	}
}

func TestRenderMarkdownBodyLinesKeepsNumericSeparatorsInSingleToken(t *testing.T) {
	enableColorRenderingForTest(t)

	lines := app.RenderMarkdownBodyLinesForTest("```py\nCONTEXT_FILE_MAX_CHARS = 20_000\n```", 80, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")
	plain := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(rendered, "")

	if !strings.Contains(plain, "CONTEXT_FILE_MAX_CHARS = 20_000") {
		t.Fatalf("expected numeric literal with separators preserved, got %q", plain)
	}
	if !strings.Contains(rendered, "38;2;121;192;255m20_000") {
		t.Fatalf("expected numeric literal rendered as a single highlighted token, got %q", rendered)
	}
}

func TestRenderMarkdownBodyLinesHandlesLinksImagesAndNestedQuotes(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest("> > See [docs](https://example.com/docs) and <https://example.com/raw>\n![diagram](https://example.com/img.png)", 96, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")
	plain := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(rendered, "")

	if strings.Contains(plain, "[docs](") || strings.Contains(plain, "![diagram](") || strings.Contains(plain, "> >") {
		t.Fatalf("expected markdown markers normalized, got %q", plain)
	}
	if !strings.Contains(plain, "│ │ ") {
		t.Fatalf("expected nested quote prefix rendered, got %q", plain)
	}
	if !strings.Contains(plain, "docs <https://example.com/docs>") || !strings.Contains(plain, "https://example.com/raw") {
		t.Fatalf("expected links preserved in readable form, got %q", plain)
	}
	if !strings.Contains(plain, "[image] diagram <https://example.com/img.png>") {
		t.Fatalf("expected image markdown summarized, got %q", plain)
	}
}

func TestRenderMarkdownBodyLinesHandlesListContinuationParagraphs(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest("- first line\n  continuation paragraph with more detail\n  another continuation line\n- second item", 96, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")
	plain := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(rendered, "")

	if !strings.Contains(plain, "continuation paragraph with more detail") || !strings.Contains(plain, "another continuation line") {
		t.Fatalf("expected list continuation text preserved, got %q", plain)
	}
	if strings.Count(plain, "• ") != 2 {
		t.Fatalf("expected exactly two rendered bullets, got %q", plain)
	}
}

func TestRenderMarkdownBodyLinesHandlesEscapesAndNestedEmphasis(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest(`***bold italic*** and **bold _nested italic_** and \*escaped\* and ~~gone~~`, 96, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")
	plain := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(rendered, "")

	if strings.Contains(plain, "***") || strings.Contains(plain, "**bold") || strings.Contains(plain, "_nested italic_") || strings.Contains(plain, "~~gone~~") {
		t.Fatalf("expected emphasis markers removed, got %q", plain)
	}
	if !strings.Contains(plain, "bold italic") || !strings.Contains(plain, "bold nested italic") || !strings.Contains(plain, "*escaped*") || !strings.Contains(plain, "gone") {
		t.Fatalf("expected nested emphasis and escapes preserved semantically, got %q", plain)
	}
}

func TestRenderMarkdownBodyLinesIgnoresInlineHTMLTags(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest(`Use <kbd>Ctrl+C</kbd> and <span class="hint">hint</span><br/>done`, 96, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")
	plain := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(rendered, "")

	if strings.Contains(plain, "<kbd>") || strings.Contains(plain, "</span>") || strings.Contains(plain, "<br/>") {
		t.Fatalf("expected inline html tags ignored, got %q", plain)
	}
	if !strings.Contains(plain, "Ctrl+C") || !strings.Contains(plain, "hint") || !strings.Contains(plain, "done") {
		t.Fatalf("expected inline html content preserved, got %q", plain)
	}
}

func TestRenderMarkdownDiffAddUsesWhiteBackgroundAndGreenMarker(t *testing.T) {
	originalProfile := lipgloss.ColorProfile()
	t.Cleanup(func() {
		lipgloss.SetColorProfile(originalProfile)
	})
	lipgloss.SetColorProfile(termenv.TrueColor)

	lines := app.RenderMarkdownBodyLinesForTest("+    1 | from __future__ import annotations", 96, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")

	if !strings.Contains(rendered, "38;2;126;231;135;48;2;16;63;43") {
		t.Fatalf("expected green add gutter background, got %q", rendered)
	}
	if !strings.Contains(rendered, "48;2;16;59;42") {
		t.Fatalf("expected dark green diff background, got %q", rendered)
	}
	if !strings.Contains(rendered, "38;2;255;155;155") {
		t.Fatalf("expected keyword syntax highlight on dark green diff background, got %q", rendered)
	}
}

func TestRenderMarkdownDiffRemoveUsesWhiteBackgroundAndRedMarker(t *testing.T) {
	originalProfile := lipgloss.ColorProfile()
	t.Cleanup(func() {
		lipgloss.SetColorProfile(originalProfile)
	})
	lipgloss.SetColorProfile(termenv.TrueColor)

	lines := app.RenderMarkdownBodyLinesForTest("-    2 | return old_value", 96, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")

	if !strings.Contains(rendered, "38;2;255;161;152;48;2;93;30;39") {
		t.Fatalf("expected red remove gutter background, got %q", rendered)
	}
	if !strings.Contains(rendered, "48;2;93;30;39") {
		t.Fatalf("expected dark red diff background, got %q", rendered)
	}
}

func TestRenderMarkdownDiffPadsTrailingBackgroundAcrossLine(t *testing.T) {
	originalProfile := lipgloss.ColorProfile()
	t.Cleanup(func() {
		lipgloss.SetColorProfile(originalProfile)
	})
	lipgloss.SetColorProfile(termenv.TrueColor)

	lines := app.RenderMarkdownBodyLinesForTest("+    1 | x", 24, lipgloss.NewStyle())
	rendered := strings.Join(lines, "\n")
	trailingBackground := regexp.MustCompile(`48;2;16;59;42m +\x1b\[0m`)

	if !trailingBackground.MatchString(rendered) {
		t.Fatalf("expected diff row background to extend through trailing padding, got %q", rendered)
	}
	if !strings.Contains(rendered, "╭─ diff preview") || !strings.Contains(rendered, "╰") {
		t.Fatalf("expected markdown diff rows to render inside a bordered block, got %q", rendered)
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

func TestRenderMarkdownBodyLinesWrapsLongTableCellsInsteadOfTruncating(t *testing.T) {
	lines := app.RenderMarkdownBodyLinesForTest(
		"| 项目维度 | 正式表述 |\n| --- | --- |\n| 建设背景 | 随着复杂开发任务、运维任务及知识处理任务对智能化辅助的要求提升，传统单轮问答式助手已难以满足多步骤执行、上下文持续维护、工具联动处理等实际场景需求。 |",
		48,
		lipgloss.NewStyle(),
	)
	rendered := strings.Join(lines, "\n")

	if !strings.Contains(rendered, "传统单轮问答式助手已难以满足") {
		t.Fatalf("expected long table cell text preserved after wrapping, got %q", rendered)
	}
	if !strings.Contains(rendered, "骤执行、上下文持续维护、工具联动") {
		t.Fatalf("expected later wrapped table content preserved, got %q", rendered)
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

func TestRenderTranscriptClampsKeycapEmojiMarkdownLayoutToWidth(t *testing.T) {
	model := app.NewModel()
	model.Items = []app.Message{
		{Role: "assistant", Kind: "transcript", Text: strings.Join([]string{
			"4️⃣ 默认配置（cyrene-cli.js 中）",
			"",
			"| 模块 | 职责 |",
			"| --- | --- |",
			"| infra/config/ | appRoot、loadCyreneConfig、loadPromptPolicy、CyreneConfig、PromptPolicy |",
			"| infra/auth/ | createAuthRuntime、AuthRuntime、AuthStatus |",
			"",
			"```js",
			"DEFAULT_CONFIG = {",
			"  requestTemperature: 0.2,",
			"}",
			"```",
			"",
			"5️⃣ Provider 支持",
		}, "\n")},
	}

	rendered := model.RenderTranscriptForTest(42, 18)
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	for _, line := range strings.Split(rendered, "\n") {
		plain := stripANSI.ReplaceAllString(line, "")
		if app.RenderedLineWidthForTest(plain) > 42 {
			t.Fatalf("expected keycap emoji layout line width <= 42, got %d for %q", app.RenderedLineWidthForTest(plain), plain)
		}
	}
}

func TestComposerPreservesLargePastedTextDisplay(t *testing.T) {
	originalProfile := lipgloss.ColorProfile()
	t.Cleanup(func() {
		lipgloss.SetColorProfile(originalProfile)
	})
	lipgloss.SetColorProfile(termenv.TrueColor)

	model := app.NewModel()
	largePaste := strings.Repeat("bulk pasted block\n", 48) + "tail marker"
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(largePaste)})

	rendered := model.RenderComposerForTest(80)
	plain := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(rendered, "")

	if !strings.Contains(plain, "bulk pasted block") {
		t.Fatalf("expected large pasted content preserved in composer, got %q", plain)
	}
	if !strings.Contains(plain, "tail marker") {
		t.Fatalf("expected pasted tail preserved in composer, got %q", plain)
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

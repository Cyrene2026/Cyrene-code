package tests

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"cyrenecode/v2/internal/app"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

var (
	ansiPattern    = regexp.MustCompile(`\x1b\[[0-9;]*m`)
	ansiSGRPattern = regexp.MustCompile(`\x1b\[([0-9;]*)m`)
)

func enableColorRenderingForTest(t *testing.T) {
	t.Helper()

	previousProfile := lipgloss.ColorProfile()
	previousDarkBackground := lipgloss.HasDarkBackground()
	lipgloss.SetColorProfile(termenv.TrueColor)
	lipgloss.SetHasDarkBackground(true)
	t.Cleanup(func() {
		lipgloss.SetColorProfile(previousProfile)
		lipgloss.SetHasDarkBackground(previousDarkBackground)
	})
}

func assertLineUsesInverseSelection(t *testing.T, view, fragment string) {
	t.Helper()

	for _, line := range strings.Split(view, "\n") {
		plain := ansiPattern.ReplaceAllString(line, "")
		if !strings.Contains(plain, fragment) {
			continue
		}
		if !lineHasInverseSelectionANSI(line) {
			t.Fatalf("expected %q to use inverse selection colors, got %q", fragment, line)
		}
		paddingPattern := regexp.MustCompile(regexp.QuoteMeta(fragment) + ` +\x1b\[[0-9;]*m`)
		if !paddingPattern.MatchString(line) {
			t.Fatalf("expected %q to keep inverse highlight across trailing padding, got %q", fragment, line)
		}
		return
	}

	t.Fatalf("expected line containing %q, got %q", fragment, view)
}

func lineHasInverseSelectionANSI(line string) bool {
	matches := ansiSGRPattern.FindAllStringSubmatch(line, -1)
	for _, match := range matches {
		tokens := strings.Split(match[1], ";")
		if sgrTokensContain(tokens, []string{"30"}) && sgrTokensContain(tokens, []string{"47"}) {
			return true
		}
		if sgrTokensContain(tokens, []string{"30"}) && sgrTokensContain(tokens, []string{"107"}) {
			return true
		}
		if sgrTokensContain(tokens, []string{"30"}) && sgrTokensContain(tokens, []string{"48", "2", "255", "255", "255"}) {
			return true
		}
		if sgrTokensContain(tokens, []string{"38", "5", "0"}) && sgrTokensContain(tokens, []string{"48", "5", "15"}) {
			return true
		}
		if sgrTokensContain(tokens, []string{"38", "2", "0", "0", "0"}) && sgrTokensContain(tokens, []string{"48", "2", "255", "255", "255"}) {
			return true
		}
	}
	return false
}

func sgrTokensContain(tokens, sequence []string) bool {
	if len(sequence) == 0 || len(tokens) < len(sequence) {
		return false
	}
	for start := 0; start <= len(tokens)-len(sequence); start++ {
		match := true
		for index, token := range sequence {
			if tokens[start+index] != token {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func commandEmitsClearScreen(cmd tea.Cmd) bool {
	for _, msg := range collectCommandMessages(cmd) {
		if reflect.TypeOf(msg).String() == "tea.clearScreenMsg" {
			return true
		}
	}
	return false
}

func collectCommandMessages(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	msg := cmd()
	if msg == nil {
		return nil
	}
	if batch, ok := msg.(tea.BatchMsg); ok {
		messages := make([]tea.Msg, 0, len(batch))
		for _, nested := range batch {
			messages = append(messages, collectCommandMessages(nested)...)
		}
		return messages
	}
	return []tea.Msg{msg}
}

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

	if model.Notice != "" {
		t.Fatalf("expected low-value help notice suppressed, got %q", model.Notice)
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
	if !strings.Contains(helpText, "/extensions exposure") {
		t.Fatalf("expected extensions commands in help text, got %q", helpText)
	}
	if !strings.Contains(helpText, "/model custom <id>") {
		t.Fatalf("expected custom model command in help text, got %q", helpText)
	}
}

func TestWheelDownReturnsToLiveTail(t *testing.T) {
	model := app.NewModel()
	model.Width = 100
	model.Height = 24
	model.TranscriptOffset = 10
	x, y, ok := model.TranscriptMousePointForTest()
	if !ok {
		t.Fatalf("expected transcript mouse point")
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonWheelDown,
		Action: tea.MouseActionPress,
		X:      x,
		Y:      y,
	})

	if model.TranscriptOffset >= 10 {
		t.Fatalf("expected wheel down to move toward live tail, got %d", model.TranscriptOffset)
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

func TestPlainAInsertsIntoComposerAtStartup(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")})

	if got := string(model.Input); got != "a" {
		t.Fatalf("expected plain a to insert at startup, got %q", got)
	}
}

func TestPlainAStillInsertsAfterF6Toggle(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.KeyMsg{Type: tea.KeyF6})
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")})

	if got := string(model.Input); got != "a" {
		t.Fatalf("expected plain a to insert after f6 toggle, got %q", got)
	}
}

func TestComposerRendersCompositionInlineAtCursor(t *testing.T) {
	model := app.NewModel()
	model.Width = 80
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("ab")})
	model.Cursor = 1
	model.SetComposerCompositionForTest("zhong", 2)

	rendered := model.RenderComposerForTest(40)

	if !strings.Contains(rendered, "azh█ongb") {
		t.Fatalf("expected committed input and composition rendered inline, got %q", rendered)
	}
}

func TestComposerCompositionCommitInsertsRunes(t *testing.T) {
	model := app.NewModel()
	model.CommitComposerCompositionForTest("中文")

	if got := string(model.Input); got != "中文" {
		t.Fatalf("expected committed composition inserted, got %q", got)
	}
	if len(model.Composition) != 0 {
		t.Fatalf("expected composition cleared after commit, got %q", string(model.Composition))
	}
}

func TestCtrlVPastesIntoComposerWithoutF6Toggle(t *testing.T) {
	restore := app.SetClipboardReaderForTest(func() (string, error) {
		return "alpha\r\nbeta", nil
	})
	defer restore()

	model := app.NewModel()
	model.Update(tea.KeyMsg{Type: tea.KeyCtrlV})

	if got := string(model.Input); got != "alpha\nbeta" {
		t.Fatalf("expected ctrl+v to paste into composer, got %q", got)
	}
}

func TestLargeCtrlVPastePreservesFullInputAndKeepsTypingFlow(t *testing.T) {
	largePaste := strings.Repeat("bulk pasted block\n", 48) + "tail marker"
	restore := app.SetClipboardReaderForTest(func() (string, error) {
		return largePaste, nil
	})
	defer restore()

	model := app.NewModel()
	model.Update(tea.KeyMsg{Type: tea.KeyCtrlV})
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(" ok")})

	if got := string(model.Input); got != largePaste+" ok" {
		t.Fatalf("expected large ctrl+v paste preserved before further typing, got %q", got)
	}
}

func TestCopyModeToggleShowsPasteNotice(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 24

	model.Update(tea.KeyMsg{Type: tea.KeyF6})
	if !strings.Contains(model.Notice, "terminal paste is active here") {
		t.Fatalf("expected copy mode notice to explain terminal paste behavior, got %q", model.Notice)
	}
	model.Update(tea.KeyMsg{Type: tea.KeyF6})
	model.Update(tea.KeyMsg{Type: tea.KeyF6})
	if !strings.Contains(model.Notice, "terminal paste is active here") {
		t.Fatalf("expected copy mode notice to explain terminal paste behavior, got %q", model.Notice)
	}
}

func TestRightClickPasteIsBlockedInMouseMode(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonRight,
		Action: tea.MouseActionPress,
	})
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("pasted text")})

	if got := string(model.Input); got != "" {
		t.Fatalf("expected right-click paste to be ignored in mouse mode, got %q", got)
	}
	if !strings.Contains(model.Notice, "Right-click paste is blocked") {
		t.Fatalf("expected right-click notice, got %q", model.Notice)
	}
}

func TestComposerPasteNormalizesCarriageReturnsAndTabs(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("alpha\r\nbeta\tgamma\rdelta")})

	if got := string(model.Input); got != "alpha\nbeta    gamma\ndelta" {
		t.Fatalf("expected normalized pasted input, got %q", got)
	}
}

func TestComposerPasteStripsWindowsFormattingRunes(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a', '\ufeff', '\u200b', '\u00a0', 'b'}})

	if got := string(model.Input); got != "a b" {
		t.Fatalf("expected windows formatting runes normalized, got %q", got)
	}
}

func TestComposerPastePreservesNoTerminalCursorArtifacts(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("❯ ❯ • 补充更多测试用例到 simplex.py:303\n       █\n        █\n        █\n         • 增加退化/无界/不可行示例")})

	if strings.Contains(string(model.Input), "█") {
		t.Fatalf("expected pasted terminal cursor artifacts stripped, got %q", string(model.Input))
	}
}

func TestLargeTerminalPastePreservesOriginalPayload(t *testing.T) {
	model := app.NewModel()
	largePaste := strings.Repeat("bulk pasted block\n", 48) + "tail marker"

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(largePaste)})
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(" next")})

	if got := string(model.Input); got != largePaste+" next" {
		t.Fatalf("expected terminal paste preserved before later typing, got %q", got)
	}
}

func TestComposerAllowsLiteralSingleBlockRuneInput(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("█")})

	if got := string(model.Input); got != "█" {
		t.Fatalf("expected literal block rune preserved, got %q", got)
	}
}

func TestCtrlOAddsImageAttachmentFromPathInput(t *testing.T) {
	root := t.TempDir()
	imagePath := filepath.Join(root, "sample.png")
	if err := os.WriteFile(imagePath, []byte{0x89, 0x50, 0x4e, 0x47}, 0o644); err != nil {
		t.Fatalf("write image: %v", err)
	}

	model := app.NewModel()
	model.AppRoot = root
	model.Update(tea.KeyMsg{Type: tea.KeyCtrlO})
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("sample.png")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	attachments := model.AttachmentsForTest()
	if len(attachments) != 1 {
		t.Fatalf("expected one attachment, got %+v", attachments)
	}
	if attachments[0].Path != imagePath {
		t.Fatalf("expected attachment path %q, got %+v", imagePath, attachments[0])
	}
	if attachments[0].MimeType != "image/png" {
		t.Fatalf("expected png mime type, got %+v", attachments[0])
	}
}

func TestCtrlOControlRuneFallbackOpensAttachmentInput(t *testing.T) {
	root := t.TempDir()
	imagePath := filepath.Join(root, "sample.png")
	if err := os.WriteFile(imagePath, []byte{0x89, 0x50, 0x4e, 0x47}, 0o644); err != nil {
		t.Fatalf("write image: %v", err)
	}

	model := app.NewModel()
	model.AppRoot = root
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{rune(15)}})
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("sample.png")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if got := len(model.AttachmentsForTest()); got != 1 {
		t.Fatalf("expected control-rune fallback to add one attachment, got %d", got)
	}
}

func TestCtrlVPastesClipboardImageAsAttachment(t *testing.T) {
	restoreImage := app.SetClipboardImageReaderForTest(func() (*app.ClipboardImage, error) {
		return &app.ClipboardImage{
			Bytes:    []byte{0x89, 0x50, 0x4e, 0x47},
			MimeType: "image/png",
			Name:     "clipboard-shot.png",
		}, nil
	})
	defer restoreImage()
	restoreText := app.SetClipboardReaderForTest(func() (string, error) {
		return "should not be used", nil
	})
	defer restoreText()

	model := app.NewModel()
	model.Update(tea.KeyMsg{Type: tea.KeyCtrlV})

	attachments := model.AttachmentsForTest()
	if len(attachments) != 1 {
		t.Fatalf("expected one pasted image attachment, got %+v", attachments)
	}
	if attachments[0].MimeType != "image/png" {
		t.Fatalf("expected png mime type, got %+v", attachments[0])
	}
	if attachments[0].Name != "clipboard-shot.png" {
		t.Fatalf("expected clipboard image name preserved, got %+v", attachments[0])
	}
	if got := string(model.Input); got != "" {
		t.Fatalf("expected image paste not to insert text into composer, got %q", got)
	}
}

func TestImageAddSlashCommandAttachesImage(t *testing.T) {
	root := t.TempDir()
	imagePath := filepath.Join(root, "sample.png")
	if err := os.WriteFile(imagePath, []byte{0x89, 0x50, 0x4e, 0x47}, 0o644); err != nil {
		t.Fatalf("write image: %v", err)
	}

	model := app.NewModel()
	model.AppRoot = root
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/image add sample.png")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	attachments := model.AttachmentsForTest()
	if len(attachments) != 1 {
		t.Fatalf("expected slash command to add one attachment, got %+v", attachments)
	}
	if attachments[0].Path != imagePath {
		t.Fatalf("expected slash command path %q, got %+v", imagePath, attachments[0])
	}
}

func TestAttachmentAddAndRemoveMouseTargetsWork(t *testing.T) {
	root := t.TempDir()
	imagePath := filepath.Join(root, "sample.png")
	if err := os.WriteFile(imagePath, []byte{0x89, 0x50, 0x4e, 0x47}, 0o644); err != nil {
		t.Fatalf("write image: %v", err)
	}

	model := app.NewModel()
	model.Width = 120
	model.Height = 28
	model.AppRoot = root

	model.Update(tea.KeyMsg{Type: tea.KeyCtrlO})
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("sample.png")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	removeX, removeY, ok := model.ComposerAttachmentRemoveMousePointForTest(0)
	if !ok {
		t.Fatalf("expected attachment remove mouse point")
	}
	model.Update(tea.MouseMsg{Button: tea.MouseButtonLeft, Action: tea.MouseActionPress, X: removeX, Y: removeY})

	if got := len(model.AttachmentsForTest()); got != 0 {
		t.Fatalf("expected attachment removed, got %d", got)
	}
}

func TestSubmitBlocksUnsupportedImageProviderFormat(t *testing.T) {
	root := t.TempDir()
	imagePath := filepath.Join(root, "sample.png")
	if err := os.WriteFile(imagePath, []byte{0x89, 0x50, 0x4e, 0x47}, 0o644); err != nil {
		t.Fatalf("write image: %v", err)
	}

	model := app.NewModel()
	model.AppRoot = root
	model.SetCurrentProviderFormatForTest("openai_chat")
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("describe this image")})
	model.Update(tea.KeyMsg{Type: tea.KeyCtrlO})
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("sample.png")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if !strings.Contains(model.Notice, "not supported") {
		t.Fatalf("expected unsupported image format notice, got %q", model.Notice)
	}
}

func TestComposerSupportsClearAndWordDeleteShortcuts(t *testing.T) {
	model := app.NewModel()
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("alpha beta gamma")})

	model.Update(tea.KeyMsg{Type: tea.KeyCtrlW})
	if got := string(model.Input); got != "alpha beta " {
		t.Fatalf("expected ctrl+w to delete previous word, got %q", got)
	}

	model.Update(tea.KeyMsg{Type: tea.KeyCtrlU})
	if got := string(model.Input); got != "" {
		t.Fatalf("expected ctrl+u to clear composer, got %q", got)
	}
	if model.Cursor != 0 {
		t.Fatalf("expected composer cursor reset, got %d", model.Cursor)
	}
}

func TestComposerSupportsHomeEndAndDeleteForward(t *testing.T) {
	model := app.NewModel()
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("abcd")})

	model.Update(tea.KeyMsg{Type: tea.KeyHome})
	model.Update(tea.KeyMsg{Type: tea.KeyDelete})
	if got := string(model.Input); got != "bcd" {
		t.Fatalf("expected delete to remove rune at cursor, got %q", got)
	}

	model.Update(tea.KeyMsg{Type: tea.KeyEnd})
	model.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	if got := string(model.Input); got != "bcd" {
		t.Fatalf("expected ctrl+k at end to keep composer unchanged, got %q", got)
	}

	model.Update(tea.KeyMsg{Type: tea.KeyHome})
	if model.Cursor != 0 {
		t.Fatalf("expected home to move cursor to start, got %d", model.Cursor)
	}
}

func TestAuthEditorSupportsClearShortcut(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelAuth
	model.AuthStep = app.AuthStepProvider
	model.AuthProvider = []rune("https://provider.example/v1")
	model.AuthCursor = len(model.AuthProvider)

	model.Update(tea.KeyMsg{Type: tea.KeyCtrlU})

	if got := string(model.AuthProvider); got != "" {
		t.Fatalf("expected ctrl+u to clear auth field, got %q", got)
	}
	if model.AuthCursor != 0 {
		t.Fatalf("expected auth cursor reset, got %d", model.AuthCursor)
	}
}

func TestViewUsesTerminalFlowPrefixes(t *testing.T) {
	model := app.NewModel()
	model.Width = 100
	model.Height = 24
	model.Items = []app.Message{
		{Role: "user", Kind: "transcript", Text: "inspect this repo"},
		{Role: "assistant", Kind: "transcript", Text: "working on it"},
		{Role: "system", Kind: "tool_status", Text: "Running read_file | main.go"},
		{Role: "system", Kind: "system_hint", Text: "Use /help"},
	}

	view := model.View()

	if strings.Contains(view, "user>") {
		t.Fatalf("expected compact transcript without user prefix, got %q", view)
	}
	if strings.Contains(view, "assistant>") {
		t.Fatalf("expected compact transcript without assistant prefix, got %q", view)
	}
	if strings.Contains(view, "tool>") {
		t.Fatalf("expected compact transcript without tool prefix, got %q", view)
	}
	if strings.Contains(view, "system>") {
		t.Fatalf("expected compact transcript without system prefix, got %q", view)
	}
}

func TestViewRemovesOuterShellBorder(t *testing.T) {
	model := app.NewModel()
	model.Width = 100
	model.Height = 24
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}

	view := model.View()

	if strings.Contains(view, "╔") || strings.Contains(view, "╗") || strings.Contains(view, "╚") || strings.Contains(view, "╝") {
		t.Fatalf("expected outer shell border removed, got %q", view)
	}
}

func TestComposerRendersSlashSessionSuggestions(t *testing.T) {
	model := app.NewModel()
	model.Width = 140
	model.Height = 24
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/resume")})

	view := model.View()

	if !strings.Contains(view, "/resume") || !strings.Contains(view, "Resume a previous conversation") {
		t.Fatalf("expected resume suggestion, got %q", view)
	}
	if !strings.Contains(view, "/clear") || !strings.Contains(view, "Start a new session with empty context") {
		t.Fatalf("expected clear suggestion, got %q", view)
	}
}

func TestSlashMenuSupportsArrowSelection(t *testing.T) {
	model := app.NewModel()
	model.Width = 140
	model.Height = 24
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/resume")})

	model.Update(tea.KeyMsg{Type: tea.KeyUp})
	if model.SlashSelection < 0 {
		t.Fatalf("expected up arrow to select a slash suggestion")
	}

	view := model.View()
	if !strings.Contains(view, "/clear") {
		t.Fatalf("expected slash suggestion list to include /clear, got %q", view)
	}

	model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if got := string(model.Input); got != "/clear" {
		t.Fatalf("expected enter to apply selected slash command, got %q", got)
	}
	if model.SlashSelection != -1 {
		t.Fatalf("expected slash selection reset after applying command, got %d", model.SlashSelection)
	}
}

func TestSlashMenuUpSelectsVisibleItemImmediatelyFromBareSlash(t *testing.T) {
	model := app.NewModel()
	model.Width = 140
	model.Height = 24

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/")})
	model.Update(tea.KeyMsg{Type: tea.KeyUp})

	if model.SlashSelection < 0 || model.SlashSelection >= 4 {
		t.Fatalf("expected first up press to select a visible slash suggestion, got %d", model.SlashSelection)
	}
}

func TestTranscriptShowsScrollbarWhenPanelClosed(t *testing.T) {
	model := app.NewModel()
	model.Width = 140
	model.Height = 24
	model.ActivePanel = app.PanelNone
	model.Items = []app.Message{
		{Role: "user", Kind: "transcript", Text: strings.Repeat("line\n", 20)},
		{Role: "assistant", Kind: "transcript", Text: strings.Repeat("reply\n", 20)},
	}

	view := model.View()

	if !strings.Contains(view, "█") && !strings.Contains(view, "│") {
		t.Fatalf("expected transcript scrollbar rail, got %q", view)
	}
}

func TestWideNavigationPageShowsSessionsContent(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 60
	model.ActivePanel = app.PanelSessions
	model.ActiveSessionID = "sess-1"
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.Sessions = []app.BridgeSession{
		{ID: "sess-1", Title: "Current session", UpdatedAt: "2026-04-11T00:00:00Z", ProjectRoot: "/workspace/current/project", Tags: []string{"active"}},
		{ID: "sess-2", Title: "Older session", UpdatedAt: "2026-04-10T00:00:00Z"},
	}

	view := model.View()

	if !strings.Contains(view, "SESSIONS") {
		t.Fatalf("expected sessions page content, got %q", view)
	}
	if strings.Contains(view, "❯ ready") {
		t.Fatalf("expected transcript hidden behind sessions page, got %q", view)
	}
	if !strings.Contains(view, "/workspace/current/project") && !strings.Contains(view, ".../current/project") {
		t.Fatalf("expected session project path in panel, got %q", view)
	}
	if !strings.Contains(view, "detail") {
		t.Fatalf("expected detail section, got %q", view)
	}
}

func TestSlashPlanShowOpensPlanPanel(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/plan show")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if model.ActivePanel != app.PanelPlans {
		t.Fatalf("expected plan panel to open, got %q", model.ActivePanel)
	}
}

func TestSlashClearStartsNewSessionFlow(t *testing.T) {
	model := app.NewModel()
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "old session"}}

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/clear")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if model.Status != app.StatusPreparing {
		t.Fatalf("expected /clear to enter preparing state, got %q", model.Status)
	}
	if model.Notice != "" {
		t.Fatalf("expected low-value /clear notice suppressed, got %q", model.Notice)
	}
	if !strings.Contains(model.View(), "old session") {
		t.Fatalf("expected current transcript to remain until bridge switches sessions")
	}
}

func TestSlashPlanCreateWithoutTaskShowsUsage(t *testing.T) {
	model := app.NewModel()

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/plan create")})
	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if model.ActivePanel != app.PanelPlans {
		t.Fatalf("expected plan panel to open, got %q", model.ActivePanel)
	}
	if !strings.Contains(model.Notice, "Usage: /plan create <task>") {
		t.Fatalf("expected usage notice, got %q", model.Notice)
	}
}

func TestPlanPanelRendersEvidencePathsAndToolResult(t *testing.T) {
	model := app.NewModel()
	model.Width = 170
	model.Height = 44
	model.ActivePanel = app.PanelPlans
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}

	if err := model.ApplyBridgeEventJSONForTest(`{"type":"set_execution_plan","executionPlan":{"capturedAt":"2026-04-13T00:00:00Z","sourcePreview":"refactor task","summary":"Refactor reducer flow","objective":"refactor reducer flow","steps":[{"id":"step-1","title":"Patch reducer transitions","details":"Update state handling and tests","status":"in_progress","evidence":["Tool read_file: inspected src/core/session/stateReducer.ts","Tool apply_patch: updated reducer branch"],"filePaths":["src/core/session/stateReducer.ts","tests/stateReducer.test.ts"],"recentToolResult":"Patched file: src/core/session/stateReducer.ts"}]}}`); err != nil {
		t.Fatalf("apply set_execution_plan: %v", err)
	}

	view := model.View()
	for _, snippet := range []string{
		"Patch reducer transitions",
		"src/core/session/stateReducer.ts",
		"tests/stateReducer.test.ts",
		"Patched file: src/core/session/stateReducer.ts",
		"Tool apply_patch: updated reducer branch",
	} {
		if !strings.Contains(view, snippet) {
			t.Fatalf("expected plan panel to contain %q, got %q", snippet, view)
		}
	}
}

func TestStartupSplashCompressesWhenPanelIsOpen(t *testing.T) {
	model := app.NewModel()
	model.Width = 180
	model.Height = 48
	model.ActivePanel = app.PanelSessions

	view := model.View()

	if strings.Contains(view, "terminal advantages") || strings.Contains(view, "fast paths") {
		t.Fatalf("expected launcher copy removed when panel is open, got %q", view)
	}
	if strings.Contains(view, "No transcript yet.") || strings.Contains(view, "Type a request below") {
		t.Fatalf("expected empty transcript copy removed when panel is open, got %q", view)
	}
	if strings.Contains(view, "PANEL sessions") {
		t.Fatalf("expected left status sidebar removed, got %q", view)
	}
	if !strings.Contains(view, "SESSIONS") {
		t.Fatalf("expected sessions panel, got %q", view)
	}
}

func TestSessionsPanelShowsScrollbarWhenPaged(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 40
	model.ActivePanel = app.PanelSessions
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.Sessions = []app.BridgeSession{
		{ID: "sess-1", Title: "Current session", UpdatedAt: "2026-04-11T00:00:00Z"},
		{ID: "sess-2", Title: "Older session", UpdatedAt: "2026-04-10T00:00:00Z"},
		{ID: "sess-3", Title: "Third session", UpdatedAt: "2026-04-09T00:00:00Z"},
		{ID: "sess-4", Title: "Fourth session", UpdatedAt: "2026-04-08T00:00:00Z"},
		{ID: "sess-5", Title: "Fifth session", UpdatedAt: "2026-04-07T00:00:00Z"},
		{ID: "sess-6", Title: "Sixth session", UpdatedAt: "2026-04-06T00:00:00Z"},
	}

	view := model.View()

	if !strings.Contains(view, "█") {
		t.Fatalf("expected panel scrollbar thumb, got %q", view)
	}
}

func TestTallSessionsPanelUsesDynamicPageSize(t *testing.T) {
	model := app.NewModel()
	model.Width = 170
	model.Height = 52
	model.ActivePanel = app.PanelSessions
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.Sessions = []app.BridgeSession{
		{ID: "sess-1", Title: "one", UpdatedAt: "2026-04-11T00:00:00Z"},
		{ID: "sess-2", Title: "two", UpdatedAt: "2026-04-10T00:00:00Z"},
		{ID: "sess-3", Title: "three", UpdatedAt: "2026-04-09T00:00:00Z"},
		{ID: "sess-4", Title: "four", UpdatedAt: "2026-04-08T00:00:00Z"},
		{ID: "sess-5", Title: "five", UpdatedAt: "2026-04-07T00:00:00Z"},
		{ID: "sess-6", Title: "six", UpdatedAt: "2026-04-06T00:00:00Z"},
	}

	view := model.View()

	if !strings.Contains(view, "six") {
		t.Fatalf("expected tall sessions panel to show more than the old fixed page size, got %q", view)
	}
}

func TestTallModelsPanelUsesDynamicPageSize(t *testing.T) {
	model := app.NewModel()
	model.Width = 170
	model.Height = 52
	model.ActivePanel = app.PanelModels
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.AvailableModels = []string{
		"model-1", "model-2", "model-3", "model-4", "model-5", "model-6",
	}

	view := model.View()

	if !strings.Contains(view, "model-6") {
		t.Fatalf("expected tall models panel to show more than the old fixed page size, got %q", view)
	}
	if !strings.Contains(view, "/model custom <id>") {
		t.Fatalf("expected models panel to mention custom model command, got %q", view)
	}
}

func TestModelsPanelSelectedEntryUsesInverseHighlight(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Width = 170
	model.Height = 40
	model.ActivePanel = app.PanelModels
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.AvailableModels = []string{"gpt-5.4", "claude-3-7-sonnet"}
	model.ModelIndex = 1

	view := model.View()

	assertLineUsesInverseSelection(t, view, "> claude-3-7-sonnet")
	assertLineUsesInverseSelection(t, view, "   family anthropic-like")
}

func TestModelPanelCustomShortcutPrefillsComposer(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelModels
	model.AvailableModels = []string{"gpt-5.4"}

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("c")})

	if model.ActivePanel != app.PanelNone {
		t.Fatalf("expected custom shortcut to close model panel, got %q", model.ActivePanel)
	}
	if got := string(model.Input); got != "/model custom " {
		t.Fatalf("expected custom shortcut to prefill composer, got %q", got)
	}
	if model.Cursor != len(model.Input) {
		t.Fatalf("expected composer cursor at end, got %d", model.Cursor)
	}
	if !strings.Contains(model.Notice, "Custom model command ready.") {
		t.Fatalf("expected custom shortcut notice, got %q", model.Notice)
	}
}

func TestTranscriptRenderKeepsHistoryAcrossLiveUpdates(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 24
	model.Items = []app.Message{
		{Role: "user", Kind: "transcript", Text: "describe the issue"},
		{Role: "assistant", Kind: "transcript", Text: "checking render path"},
	}

	if err := model.ApplyBridgeEventJSONForTest(`{"type":"set_live_text","liveText":"streaming response chunk"}`); err != nil {
		t.Fatalf("apply set_live_text: %v", err)
	}

	view := model.View()
	if !strings.Contains(view, "describe the issue") {
		t.Fatalf("expected existing transcript history, got %q", view)
	}
	if !strings.Contains(view, "streaming response chunk") {
		t.Fatalf("expected live transcript tail, got %q", view)
	}

	if err := model.ApplyBridgeEventJSONForTest(`{"type":"set_live_text","liveText":"streaming response chunk updated"}`); err != nil {
		t.Fatalf("apply second set_live_text: %v", err)
	}

	view = model.View()
	if !strings.Contains(view, "checking render path") {
		t.Fatalf("expected cached history to remain visible, got %q", view)
	}
	if !strings.Contains(view, "streaming response chunk updated") {
		t.Fatalf("expected latest live transcript text, got %q", view)
	}
}

func TestLiveTranscriptRendersAfterTrailingToolStatuses(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 24
	model.Items = []app.Message{
		{Role: "user", Kind: "transcript", Text: "fix the bug"},
		{Role: "system", Kind: "tool_status", Text: "Running read_file | main.go..."},
		{Role: "system", Kind: "tool_status", Text: "Tool: read_file main.go | content hidden"},
	}
	model.LiveText = "先补齐中间实现，再直接改 simplex.py。"

	view := model.View()
	liveIndex := strings.Index(view, "先补齐中间实现，再直接改 simplex.py。")
	toolIndex := strings.Index(view, "read read_file")
	if liveIndex < 0 || toolIndex < 0 {
		t.Fatalf("expected both live transcript and tool status, got %q", view)
	}
	if liveIndex < toolIndex {
		t.Fatalf("expected live transcript to render after trailing tool statuses, got %q", view)
	}
}

func TestStartupSplashReturnsAfterLiveTextClears(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 24

	if err := model.ApplyBridgeEventJSONForTest(`{"type":"set_live_text","liveText":"temporary reply"}`); err != nil {
		t.Fatalf("apply set_live_text: %v", err)
	}
	if err := model.ApplyBridgeEventJSONForTest(`{"type":"set_live_text","liveText":""}`); err != nil {
		t.Fatalf("clear set_live_text: %v", err)
	}

	view := model.View()
	if strings.Contains(view, "No transcript yet.") || strings.Contains(view, "Type a request below") || strings.Contains(view, "cyrene ready") {
		t.Fatalf("expected legacy empty state removed after live text clears, got %q", view)
	}
	if !strings.Contains(view, "██████") || !strings.Contains(view, "Ask naturally") {
		t.Fatalf("expected startup guide after live text clears, got %q", view)
	}
}

func TestStartupGuideRendersDoubleLogoAndHints(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 30
	model.AppRoot = "/workspace/demo"
	model.CurrentModel = "gpt-5.4"
	model.CurrentProvider = "https://code.newcli.com/codex/v1"

	view := model.View()
	plainView := ansiPattern.ReplaceAllString(view, "")
	if strings.Contains(view, "> Cyrene") || strings.Contains(view, "terminal-first agentic coding workspace") {
		t.Fatalf("expected startup header copy removed, got %q", view)
	}
	if !strings.Contains(view, "██████") {
		t.Fatalf("expected ANSI shadow logo, got %q", view)
	}
	for _, hint := range []string{"Ask naturally", "/model", "/provider", "Ctrl+O"} {
		if !strings.Contains(view, hint) {
			t.Fatalf("expected startup hint %q, got %q", hint, view)
		}
	}
	if !strings.Contains(plainView, "WORKSPACE demo") ||
		!strings.Contains(plainView, "MODEL gpt-5.4") ||
		!strings.Contains(plainView, "PROVIDER Newcli") {
		t.Fatalf("expected startup runtime status line, got %q", view)
	}

	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	lines := strings.Split(view, "\n")
	for _, line := range lines {
		plain := stripANSI.ReplaceAllString(line, "")
		if app.RenderedLineWidthForTest(plain) > model.Width {
			t.Fatalf("expected startup line width <= %d, got %d for %q", model.Width, app.RenderedLineWidthForTest(plain), plain)
		}
	}
	logoLine := -1
	for index, line := range lines {
		if strings.Contains(line, "██████") {
			logoLine = index
			break
		}
	}
	if logoLine < 4 {
		t.Fatalf("expected startup landing block to be vertically centered, first logo line=%d in %q", logoLine, view)
	}
}

func TestTranscriptMessageCacheExtendsAcrossAppendItems(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 24
	model.Items = []app.Message{
		{Role: "user", Kind: "transcript", Text: strings.Repeat("A", 200)},
		{Role: "assistant", Kind: "transcript", Text: strings.Repeat("B", 200)},
	}

	_ = model.View()
	if got := model.TranscriptMessageCacheCountForTest(); got != 2 {
		t.Fatalf("expected 2 cached messages after initial render, got %d", got)
	}
	initialWidth := model.TranscriptMessageCacheWidthForTest(0)
	if initialWidth == 0 {
		t.Fatalf("expected first cached message to record render width")
	}

	if err := model.ApplyBridgeEventJSONForTest(`{"type":"append_items","items":[{"role":"system","kind":"system_hint","text":"extra note"}]}`); err != nil {
		t.Fatalf("apply append_items: %v", err)
	}

	_ = model.View()
	if got := model.TranscriptMessageCacheCountForTest(); got != 3 {
		t.Fatalf("expected cache to extend for appended message, got %d", got)
	}
	if got := model.TranscriptMessageCacheWidthForTest(0); got != initialWidth {
		t.Fatalf("expected existing cached message width to be preserved, got %d want %d", got, initialWidth)
	}
	if got := model.TranscriptMessageCacheWidthForTest(2); got == 0 {
		t.Fatalf("expected appended message to populate cache width")
	}
}

func TestPanelHeaderShowsControlsBeforePageSummary(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 40
	model.ActivePanel = app.PanelSessions
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.Sessions = []app.BridgeSession{
		{ID: "sess-1", Title: "Current session", UpdatedAt: "2026-04-11T00:00:00Z"},
	}

	view := model.View()
	controls := strings.Index(view, "SEL")
	summary := strings.Index(view, "SESSIONS")
	if controls < 0 || summary < 0 {
		t.Fatalf("expected panel header content, got %q", view)
	}
	if controls > summary {
		t.Fatalf("expected controls row before summary row, got %q", view)
	}
	for _, segment := range []string{"PAGE", "LOAD", "REFRESH", "ESC", "│"} {
		if !strings.Contains(view, segment) {
			t.Fatalf("expected evenly distributed control segment %q, got %q", segment, view)
		}
	}
}

func TestPanelSummaryStaysAtBottomOfSessionsPanel(t *testing.T) {
	model := app.NewModel()
	model.Width = 170
	model.Height = 36
	model.ActivePanel = app.PanelSessions
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.Sessions = []app.BridgeSession{
		{ID: "s1", Title: "one", UpdatedAt: "2026-04-11T00:00:00Z"},
		{ID: "s2", Title: "two", UpdatedAt: "2026-04-10T00:00:00Z"},
		{ID: "s3", Title: "three", UpdatedAt: "2026-04-09T00:00:00Z"},
	}

	view := model.View()
	lines := strings.Split(view, "\n")
	summaryLine := -1
	for index, line := range lines {
		if strings.Contains(line, "SESSIONS") && strings.Contains(line, "TOTAL 3") {
			summaryLine = index
		}
	}

	if summaryLine < 0 {
		t.Fatalf("expected sessions summary/footer lines, got %q", view)
	}
	if summaryLine > len(lines)-5 {
		t.Fatalf("expected sessions summary near panel bottom, got %q", view)
	}
	if strings.Contains(lines[summaryLine], "┘") || strings.Contains(lines[summaryLine], "└") {
		t.Fatalf("expected sessions summary near panel bottom, got %q", view)
	}
	if summaryLine+1 >= len(lines) {
		t.Fatalf("expected one blank line below sessions summary, got %q", view)
	}
	nextLineContent := strings.NewReplacer("│", "", "┌", "", "┐", "", "└", "", "┘", "").Replace(lines[summaryLine+1])
	if strings.TrimSpace(nextLineContent) != "" {
		t.Fatalf("expected one blank line below sessions summary, got %q", view)
	}
}

func TestWideNavigationPanelUsesFullMainArea(t *testing.T) {
	model := app.NewModel()
	model.Width = 180
	model.Height = 50
	model.ActivePanel = app.PanelSessions

	view := model.View()

	if !strings.Contains(view, "SESSIONS") {
		t.Fatalf("expected sessions page content visible, got %q", view)
	}
	if strings.Contains(view, "❯ ready") {
		t.Fatalf("expected transcript hidden behind full-page navigation panel, got %q", view)
	}
	if !strings.Contains(view, "┌") || !strings.Contains(view, "┘") {
		t.Fatalf("expected panels to render with a visible border, got %q", view)
	}
	if strings.Contains(view, "48;2;255;255;255") {
		t.Fatalf("expected panel chrome to avoid high-contrast white header/background, got %q", view)
	}
}

func TestViewUsesBorderedFullscreenPanelWithoutSidebar(t *testing.T) {
	model := app.NewModel()
	model.Width = 100
	model.Height = 24
	model.ActivePanel = app.PanelSessions
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.Sessions = []app.BridgeSession{
		{ID: "sess-1", Title: "Current session", UpdatedAt: "2026-04-11T00:00:00Z"},
	}

	view := model.View()

	if strings.Contains(view, "PANEL sessions") {
		t.Fatalf("expected left status sidebar removed, got %q", view)
	}
	if strings.Contains(view, "❯ ready") {
		t.Fatalf("expected transcript hidden when sessions page is open, got %q", view)
	}
	if !strings.Contains(view, "┌") || !strings.Contains(view, "┐") || !strings.Contains(view, "└") || !strings.Contains(view, "┘") {
		t.Fatalf("expected pane border glyphs, got %q", view)
	}
}

func TestApprovalPreviewLooksLikeTerminalDiff(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 60
	model.ActivePanel = app.PanelApprovals
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.PendingReviews = []app.BridgeReview{
		{
			ID:             "rev-1",
			Action:         "edit_file",
			Path:           "a.txt",
			PreviewSummary: "@@ chunk @@\n+   12 | added value\n-   10 | removed value",
			PreviewFull:    "@@ chunk @@\n+   12 | added value\n-   10 | removed value",
			CreatedAt:      "2026-04-11T00:00:00Z",
		},
	}

	view := model.View()
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	plainView := stripANSI.ReplaceAllString(view, "")

	if !strings.Contains(plainView, "+   12 │") {
		t.Fatalf("expected terminal diff add gutter, got %q", view)
	}
	if !strings.Contains(plainView, "-   10 │") {
		t.Fatalf("expected terminal diff remove gutter, got %q", view)
	}
	if !strings.Contains(plainView, "╭─ approval preview") {
		t.Fatalf("expected approval preview bordered block, got %q", view)
	}
	if !strings.Contains(plainView, "KIND") || !strings.Contains(plainView, "PATH") || !strings.Contains(plainView, "CREATED") {
		t.Fatalf("expected approval detail metadata and styled preview sections, got %q", view)
	}
}

func TestHeaderMovesCommandHintsToHelp(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Width = 120
	model.Height = 32
	model.AppRoot = "/workspace/demo/project/very/long/path/example"
	model.CurrentModel = "gpt-5.4"
	model.CurrentProvider = "https://code.newcli.com/codex/v1"
	model.CurrentProviderFormat = "openai_responses"
	model.UsageSummary = app.BridgeUsageSummary{CachedTokens: 400, TotalTokens: 1560}

	view := model.View()
	plainView := ansiPattern.ReplaceAllString(view, "")
	headerLine := strings.Split(plainView, "\n")[0]

	if strings.Contains(plainView, "/login  /provider  /model") {
		t.Fatalf("expected command catalog removed from header, got %q", view)
	}
	if strings.Contains(headerLine, "STATUS") || strings.Contains(headerLine, "PROJECT") {
		t.Fatalf("expected top status row removed, got %q", headerLine)
	}
	footerLine := ""
	for _, line := range strings.Split(view, "\n") {
		plainLine := ansiPattern.ReplaceAllString(line, "")
		if strings.Contains(plainLine, "TOKENS 1.6k") &&
			strings.Contains(plainLine, "CACHE 400") &&
			strings.Contains(plainLine, "TIME") &&
			strings.Contains(plainLine, "BRANCH") &&
			strings.Contains(plainLine, "PROJECT") &&
			strings.Contains(plainLine, "MODEL gpt-5.4") &&
			strings.Contains(plainLine, "PROVIDER Newcli") {
			footerLine = plainLine
		}
	}
	if footerLine == "" {
		t.Fatalf("expected unified footer status row, got %q", view)
	}
	if strings.Contains(footerLine, "SESSION") || strings.Contains(footerLine, "FORMAT") {
		t.Fatalf("expected session/format removed from footer, got %q", footerLine)
	}
	if !strings.Contains(footerLine, "PROVIDER Newcli") {
		t.Fatalf("expected provider status to show friendly provider name, got %q", footerLine)
	}
	if !strings.Contains(footerLine, "STATUS") {
		t.Fatalf("expected interaction status in footer, got %q", footerLine)
	}
	if !strings.Contains(footerLine, "TOKENS 1.6k") {
		t.Fatalf("expected token usage in unified footer row, got %q", footerLine)
	}
	if !strings.Contains(footerLine, "CACHE 400") {
		t.Fatalf("expected cached token usage in unified footer row, got %q", footerLine)
	}
	if !strings.Contains(footerLine, "TIME") {
		t.Fatalf("expected request timer in unified footer row, got %q", footerLine)
	}
	if !strings.Contains(footerLine, "BRANCH") {
		t.Fatalf("expected git branch label in unified footer row, got %q", footerLine)
	}
	if regexp.MustCompile(`\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b`).MatchString(footerLine) && !strings.Contains(footerLine, "PROJECT") {
		t.Fatalf("expected project metadata when detailed clock fits, got %q", footerLine)
	}
	if strings.Contains(plainView, "Enter send | Tab complete") {
		t.Fatalf("expected legacy helper line removed from composer, got %q", view)
	}
	promptIndex := strings.Index(plainView, "❯ Ask Cyrene, add images with Ctrl+O, use / commands, or mention files with @...")
	statusIndex := strings.Index(plainView, "TOKENS 1.6k")
	if promptIndex < 0 || statusIndex < 0 || promptIndex > statusIndex {
		t.Fatalf("expected prompt block above footer status row, got %q", view)
	}
	if !strings.Contains(plainView, "┃ ❯ Ask Cyrene") {
		t.Fatalf("expected composer focus rail without solid divider lines, got %q", view)
	}
}

func TestFooterPrioritizesCoreStatusAndCacheOnNarrowWidth(t *testing.T) {
	model := app.NewModel()
	model.Width = 72
	model.Height = 24
	model.AppRoot = "/workspace/demo/project/very/long/path/example"
	model.GitBranch = "feature/very-long-branch-name"
	model.CurrentModel = "gpt-5.4"
	model.CurrentProvider = "https://code.newcli.com/codex/v1"
	model.UsageSummary = app.BridgeUsageSummary{CachedTokens: 0, TotalTokens: 1560}

	footer := ansiPattern.ReplaceAllString(model.RenderBottomStatusBarForTest(72), "")
	for _, required := range []string{"TOKENS 1.6k", "CACHE 0", "MODEL gpt-5.4", "PROVIDER Newcli", "STATUS"} {
		if !strings.Contains(footer, required) {
			t.Fatalf("expected narrow footer to keep %q, got %q", required, footer)
		}
	}
	for _, hidden := range []string{"PROJECT", "BRANCH", "TIME"} {
		if strings.Contains(footer, hidden) {
			t.Fatalf("expected narrow footer to hide %q, got %q", hidden, footer)
		}
	}
}

func TestFooterAvoidsDedicatedBackgroundLayer(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Width = 120
	model.Height = 24

	footer := model.RenderBottomStatusBarForTest(120)
	if strings.Contains(footer, "48;2;8;13;22") {
		t.Fatalf("expected footer to avoid dedicated gray background layer, got %q", footer)
	}
}

func TestComposerUsesTextareaCursorRendering(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hello")})

	rendered := model.RenderComposerForTest(40)

	if !strings.Contains(rendered, "hello") {
		t.Fatalf("expected composer textarea to render input text, got %q", rendered)
	}
	if strings.Contains(rendered, "hello|") {
		t.Fatalf("expected composer textarea to stop rendering pipe cursor, got %q", rendered)
	}
	if !strings.Contains(rendered, "48;2;22;27;34") {
		t.Fatalf("expected composer input surface to render gray background, got %q", rendered)
	}
}

func TestComposerFocusAccentTracksStatus(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Width = 100
	model.Height = 24
	model.Status = app.StatusStreaming

	view := model.View()
	if !strings.Contains(view, "38;2;121;192;255") {
		t.Fatalf("expected focused composer accent to use active blue status color, got %q", view)
	}
	if !strings.Contains(view, "┃") {
		t.Fatalf("expected focused composer to render a left accent rail, got %q", view)
	}
}

func TestComposerKeepsBackgroundColorOnTypedText(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hello")})

	rendered := model.RenderComposerForTest(40)
	lineWithInput := ""
	for _, line := range strings.Split(rendered, "\n") {
		if strings.Contains(ansiPattern.ReplaceAllString(line, ""), "hello") {
			lineWithInput = line
			break
		}
	}
	if lineWithInput == "" {
		t.Fatalf("expected rendered composer line containing input, got %q", rendered)
	}
	if !strings.Contains(lineWithInput, "48;2;22;27;34") {
		t.Fatalf("expected typed text to keep composer gray background, got %q", lineWithInput)
	}
}

func TestComposerRendersThreeInputRowsWithoutSolidDividers(t *testing.T) {
	model := app.NewModel()

	rendered := model.RenderComposerForTest(40)

	if got := lipgloss.Height(rendered); got != 3 {
		t.Fatalf("expected composer to render exactly three rows, got %d in %q", got, rendered)
	}
	for _, line := range strings.Split(ansiPattern.ReplaceAllString(rendered, ""), "\n") {
		trimmed := strings.TrimSpace(line)
		if len([]rune(trimmed)) >= 20 && strings.Trim(trimmed, "─") == "" {
			t.Fatalf("expected composer to avoid solid divider rows, got %q in %q", line, rendered)
		}
	}
}

func TestComposerPromptRendersOnSecondInputRow(t *testing.T) {
	model := app.NewModel()

	rendered := model.RenderComposerForTest(40)
	lines := strings.Split(ansiPattern.ReplaceAllString(rendered, ""), "\n")

	if len(lines) < 2 {
		t.Fatalf("expected composer to render multiple rows, got %q", rendered)
	}
	if strings.TrimSpace(lines[0]) != "┃" {
		t.Fatalf("expected first composer row to be blank inside focus rail, got %q in %q", lines[0], rendered)
	}
	if strings.Contains(lines[0], "Ask Cyrene") {
		t.Fatalf("expected first composer row to stay blank, got %q in %q", lines[0], rendered)
	}
	if !strings.Contains(lines[1], "❯ Ask Cyrene") {
		t.Fatalf("expected composer prompt on second row, got %q in %q", lines[1], rendered)
	}
}

func TestComposerTypedTextStartsOnFirstInputRow(t *testing.T) {
	model := app.NewModel()
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hello")})

	rendered := model.RenderComposerForTest(40)
	lines := strings.Split(ansiPattern.ReplaceAllString(rendered, ""), "\n")

	if len(lines) < 2 {
		t.Fatalf("expected composer to render multiple rows, got %q", rendered)
	}
	if !strings.Contains(lines[0], "❯ hello") {
		t.Fatalf("expected typed text on first composer row, got %q in %q", lines[0], rendered)
	}
	if strings.Contains(lines[1], "hello") {
		t.Fatalf("expected second composer row to stay available after typed text starts, got %q in %q", lines[1], rendered)
	}
}

func TestPagePanelsHideComposer(t *testing.T) {
	for _, panel := range []app.Panel{app.PanelAuth, app.PanelProviders, app.PanelModels, app.PanelPlans} {
		model := app.NewModel()
		model.Width = 140
		model.Height = 32
		model.ActivePanel = panel
		model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
		model.AvailableProviders = []string{"https://api.example.com/v1"}
		model.AvailableModels = []string{"gpt-5.4"}
		model.ExecutionPlan = app.ExecutionPlan{
			Summary: "Test plan",
			Steps:   []app.ExecutionPlanStep{{ID: "step-1", Title: "Do work", Status: "pending"}},
		}

		view := model.View()
		plainView := ansiPattern.ReplaceAllString(view, "")
		if strings.Contains(plainView, "❯ Ask Cyrene") || strings.Contains(plainView, "Panel "+string(panel)+" active") {
			t.Fatalf("expected %s panel to hide composer, got %q", panel, view)
		}
		if anchor := model.TerminalCursorAnchorForTest(); anchor.Active {
			t.Fatalf("expected %s panel to clear terminal cursor anchor, got %+v", panel, anchor)
		}
	}
}

func TestComposerKeepsLongInputVisibleAfterThreshold(t *testing.T) {
	model := app.NewModel()
	longInput := strings.Repeat("long input line ", 90)
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(longInput)})

	rendered := model.RenderComposerForTest(40)

	if strings.Contains(rendered, "chars") {
		t.Fatalf("expected composer to keep long input visible instead of collapsing to a count summary, got %q", rendered)
	}
	if !strings.Contains(rendered, "long input line") {
		t.Fatalf("expected long composer input to remain visible, got %q", rendered)
	}
}

func TestComposerKeepsCursorVisibleWhenMovedUpInLongMultilineInput(t *testing.T) {
	model := app.NewModel()
	model.Width = 80
	model.Height = 24
	lines := []string{
		"line 1",
		"line 2",
		"line 3",
		"line 4",
		"line 5",
		"line 6",
		"line 7",
		"line 8",
	}
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(strings.Join(lines, "\n"))})
	for range 4 {
		model.Update(tea.KeyMsg{Type: tea.KeyLeft})
	}

	rendered := model.RenderComposerForTest(40)

	if !strings.Contains(rendered, "█") || !strings.Contains(rendered, "line 7") {
		t.Fatalf("expected composer to still show the cursor window near the current line, got %q", rendered)
	}
	if strings.Contains(rendered, "1 char") {
		t.Fatalf("expected composer not to collapse to a count summary, got %q", rendered)
	}
}

func TestViewAnchorsTerminalCursorToComposer(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 28
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hello")})

	_ = model.View()
	anchor := model.TerminalCursorAnchorForTest()

	if !anchor.Active {
		t.Fatalf("expected terminal cursor anchor to be active")
	}
	if anchor.RowsUp <= 0 {
		t.Fatalf("expected anchor to move up from footer to composer, got %+v", anchor)
	}
	if anchor.ColumnsRight <= len("hello") {
		t.Fatalf("expected anchor column to include left padding and prompt, got %+v", anchor)
	}
}

func TestCursorAnchoredOutputWritesRestoreAndAnchorSequences(t *testing.T) {
	var buffer bytes.Buffer
	anchor := app.TerminalCursorAnchor{Active: true, RowsUp: 2, ColumnsRight: 7}
	output := app.NewCursorAnchoredWriterForTest(&buffer, func() app.TerminalCursorAnchor {
		return anchor
	})

	if n, err := output.Write([]byte("first")); err != nil || n != len("first") {
		t.Fatalf("first write returned n=%d err=%v", n, err)
	}
	if got, want := buffer.String(), "first\x1b[2A\x1b[7C"; got != want {
		t.Fatalf("expected first write to anchor cursor, got %q want %q", got, want)
	}

	anchor = app.TerminalCursorAnchor{}
	if n, err := output.Write([]byte("second")); err != nil || n != len("second") {
		t.Fatalf("second write returned n=%d err=%v", n, err)
	}
	if got, want := buffer.String(), "first\x1b[2A\x1b[7C\r\x1b[2Bsecond"; got != want {
		t.Fatalf("expected second write to restore before rendering, got %q want %q", got, want)
	}
}

func TestSlashSuggestionsIncludeExtensionsAndRenderProfessionalHints(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 28
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/ext")})

	view := model.View()
	if !strings.Contains(view, "/extensions") {
		t.Fatalf("expected extensions suggestion in composer, got %q", view)
	}
	lines := strings.Split(view, "\n")
	firstSuggestionLine := -1
	promptLine := -1
	for index, line := range lines {
		if firstSuggestionLine < 0 && strings.Contains(line, "/extensions") {
			firstSuggestionLine = index
		}
		if strings.Contains(line, "❯ /ext") {
			promptLine = index
		}
	}
	if firstSuggestionLine <= 0 || promptLine <= firstSuggestionLine || promptLine+1 >= len(lines) {
		t.Fatalf("expected slash suggestion block layout discoverable, got %q", view)
	}
	if !strings.Contains(lines[firstSuggestionLine], "┃") || !strings.Contains(lines[promptLine], "┃") {
		t.Fatalf("expected slash suggestion block to stay inside focused composer rail, got %q", view)
	}
	if !strings.Contains(view, "show extensions runtime summary") {
		t.Fatalf("expected suggestion description in composer, got %q", view)
	}
}

func TestTabCompletesExtensionsCommandTemplate(t *testing.T) {
	model := app.NewModel()
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/extensions expo")})
	model.Update(tea.KeyMsg{Type: tea.KeyTab})

	if got := string(model.Input); got != "/extensions exposure " {
		t.Fatalf("expected tab completion for extensions exposure, got %q", got)
	}
}

func TestExtensionsExposureShowsDynamicModeSuggestions(t *testing.T) {
	model := app.NewModel()
	model.Width = 140
	model.Height = 28
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/extensions exposure ")})

	view := model.View()
	for _, value := range []string{"hidden", "hinted", "scoped", "full"} {
		if !strings.Contains(view, value) {
			t.Fatalf("expected dynamic exposure suggestion %q, got %q", value, view)
		}
	}
}

func TestExtensionsExposurePartialQueryFiltersDynamicModes(t *testing.T) {
	model := app.NewModel()
	model.Width = 140
	model.Height = 28
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/extensions exposure hi")})

	view := model.View()
	if !strings.Contains(view, "hidden") {
		t.Fatalf("expected hidden mode suggestion, got %q", view)
	}
	if !strings.Contains(view, "hinted") {
		t.Fatalf("expected hinted mode suggestion, got %q", view)
	}
}

func TestExtensionsTargetSuggestionsUseRuntimeMetadata(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 30

	err := model.ApplyBridgeEventJSONForTest(`{
		"type":"set_runtime_metadata",
		"appRoot":"/workspace/project-b",
		"auth":{"mode":"http","credentialSource":"env","provider":"https://provider/v1","model":"gpt-5.4","persistenceLabel":"env","persistencePath":"","httpReady":true,"onboardingAvailable":false},
		"currentModel":"gpt-5.4",
		"currentProvider":"https://provider/v1",
		"currentProviderKeySource":"env",
		"availableModels":["gpt-5.4"],
		"availableProviders":["https://provider/v1"],
		"providerProfiles":{"https://provider/v1":"openai"},
		"providerProfileSources":{"https://provider/v1":"manual"},
		"managedSkills":[{"id":"repo-map","label":"Repo Map","exposure":"scoped","source":"project"}],
		"managedMcpServers":[{"id":"filesystem","label":"Filesystem","exposure":"full","scope":"default","trusted":true}]
	}`)
	if err != nil {
		t.Fatalf("set_runtime_metadata failed: %v", err)
	}

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/extensions show ")})
	view := model.View()
	if !strings.Contains(view, "skill:repo-map") {
		t.Fatalf("expected skill target suggestion, got %q", view)
	}
	if !strings.Contains(view, "mcp:filesystem") {
		t.Fatalf("expected mcp target suggestion, got %q", view)
	}
	if !strings.Contains(view, "Repo Map") || !strings.Contains(view, "Filesystem") {
		t.Fatalf("expected target labels in dynamic suggestions, got %q", view)
	}
}

func TestTabCompletesDynamicExtensionsTarget(t *testing.T) {
	model := app.NewModel()
	err := model.ApplyBridgeEventJSONForTest(`{
		"type":"set_runtime_metadata",
		"managedSkills":[{"id":"repo-map","label":"Repo Map","exposure":"scoped","source":"project"}],
		"managedMcpServers":[]
	}`)
	if err != nil {
		t.Fatalf("set_runtime_metadata failed: %v", err)
	}

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/extensions show repo")})
	model.Update(tea.KeyMsg{Type: tea.KeyTab})

	if got := string(model.Input); got != "/extensions show skill:repo-map" {
		t.Fatalf("expected dynamic target completion, got %q", got)
	}
}

func TestExtensionsEnableShowsDynamicTargets(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 30

	err := model.ApplyBridgeEventJSONForTest(`{
		"type":"set_runtime_metadata",
		"managedSkills":[{"id":"repo-map","label":"Repo Map","exposure":"scoped","source":"project"}],
		"managedMcpServers":[{"id":"filesystem","label":"Filesystem","exposure":"full","scope":"default","trusted":true}]
	}`)
	if err != nil {
		t.Fatalf("set_runtime_metadata failed: %v", err)
	}

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/extensions enable ")})
	view := model.View()
	if !strings.Contains(view, "skill:repo-map") || !strings.Contains(view, "mcp:filesystem") {
		t.Fatalf("expected enable target suggestions, got %q", view)
	}
}

func TestProviderEndpointShowsDynamicKindSuggestions(t *testing.T) {
	model := app.NewModel()
	model.Width = 140
	model.Height = 28
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/provider endpoint ")})

	view := model.View()
	for _, value := range []string{"responses", "chat_completions", "models"} {
		if !strings.Contains(view, value) {
			t.Fatalf("expected endpoint kind suggestion %q, got %q", value, view)
		}
	}
}

func TestProviderEndpointClearShowsDynamicKindSuggestions(t *testing.T) {
	model := app.NewModel()
	model.Width = 140
	model.Height = 28
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/provider endpoint clear ")})

	view := model.View()
	for _, value := range []string{"responses", "chat_completions", "models"} {
		if !strings.Contains(view, value) {
			t.Fatalf("expected clear kind suggestion %q, got %q", value, view)
		}
	}
}

func TestTabCompletesProviderEndpointKind(t *testing.T) {
	model := app.NewModel()
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/provider endpoint chat")})
	model.Update(tea.KeyMsg{Type: tea.KeyTab})

	if got := string(model.Input); got != "/provider endpoint chat_completions " {
		t.Fatalf("expected endpoint kind completion, got %q", got)
	}
}

func TestTabCompletesProviderEndpointClearKind(t *testing.T) {
	model := app.NewModel()
	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/provider endpoint clear ge")})
	model.Update(tea.KeyMsg{Type: tea.KeyTab})

	if got := string(model.Input); got != "/provider endpoint clear gemini_generate_content " {
		t.Fatalf("expected clear kind completion, got %q", got)
	}
}

func TestPreparingStatusShowsSpinnerFrame(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 32
	model.Status = app.StatusPreparing
	model.SpinnerFrame = 3

	view := model.View()
	plainView := ansiPattern.ReplaceAllString(view, "")

	if !strings.Contains(plainView, "STATUS ⠸ PREPARING") {
		t.Fatalf("expected animated preparing status in footer, got %q", view)
	}
}

func TestFooterShowsActiveRequestElapsedTime(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 32
	model.Status = app.StatusStreaming
	model.RequestTimingActive = true
	model.RequestTimingStartedAt = time.Now().Add(-2500 * time.Millisecond)

	view := model.View()
	plainView := ansiPattern.ReplaceAllString(view, "")

	if !regexp.MustCompile(`TIME 2\.[0-9]s`).MatchString(plainView) {
		t.Fatalf("expected active request timer in footer, got %q", view)
	}
}

func TestToolStatusRendersDedicatedChip(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Width = 110
	model.Height = 24
	model.Items = []app.Message{
		{Role: "system", Kind: "tool_status", Text: "Tool: read_file src/main.go | content hidden"},
		{Role: "system", Kind: "tool_status", Text: "Tool: git_diff . | 3 files changed"},
	}

	view := model.View()
	plainView := ansiPattern.ReplaceAllString(view, "")
	for _, expected := range []string{"read read_file", "git git_diff"} {
		if !strings.Contains(plainView, expected) {
			t.Fatalf("expected dedicated tool chip %q, got %q", expected, view)
		}
	}
	if strings.Contains(plainView, "❯ Tool: read_file") {
		t.Fatalf("expected tool status not to use generic transcript prompt, got %q", view)
	}
}

func TestConsecutiveToolStatusesRenderCompactGroup(t *testing.T) {
	model := app.NewModel()
	model.Width = 110
	model.Height = 24
	model.Items = []app.Message{
		{Role: "system", Kind: "tool_status", Text: "Tool: read_file a.go | content hidden"},
		{Role: "system", Kind: "tool_status", Text: "Tool: read_file b.go | content hidden"},
		{Role: "assistant", Kind: "transcript", Text: "done"},
	}

	rendered := model.RenderTranscriptForTest(100, 14)
	plain := ansiPattern.ReplaceAllString(rendered, "")
	if strings.Contains(plain, "read read_file\n\nread read_file") {
		t.Fatalf("expected consecutive tool statuses to stay compact, got %q", rendered)
	}
	if strings.Count(plain, "read read_file") != 2 {
		t.Fatalf("expected both tool statuses in compact group, got %q", rendered)
	}
}

func TestFooterShowsFinalizedRequestElapsedTime(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 32
	model.Status = app.StatusIdle

	if err := model.ApplyBridgeEventJSONForTest(`{
		"type":"set_request_timing",
		"requestTiming":{"active":false,"startedAt":"2026-04-21T00:00:00Z","elapsedMs":65000}
	}`); err != nil {
		t.Fatalf("set_request_timing failed: %v", err)
	}

	view := model.View()
	plainView := ansiPattern.ReplaceAllString(view, "")
	if !strings.Contains(plainView, "TIME 1m05s") {
		t.Fatalf("expected finalized request timer in footer, got %q", view)
	}
}

func TestFooterClockClampsTransientSixSecondForwardJump(t *testing.T) {
	base := time.Date(2026, 4, 22, 1, 34, 52, 0, time.Local)
	expected := base.Add(120 * time.Millisecond)
	observed := base.Add(6*time.Second + 240*time.Millisecond)

	stabilized := app.StabilizeStatusClockForTest(expected, observed)
	if !stabilized.Equal(expected) {
		t.Fatalf("expected transient +6s jump to clamp to %v, got %v", expected, stabilized)
	}
}

func TestActiveRequestTimerIgnoresStartedAtClockSkew(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 32
	model.Status = app.StatusStreaming

	base := time.Now()
	current := base
	restore := app.SetTimeNowForTest(func() time.Time {
		return current
	})
	defer restore()

	model.ObserveTimeForTest(base)
	payload := fmt.Sprintf(`{
		"type":"set_request_timing",
		"requestTiming":{"active":true,"startedAt":"%s","elapsedMs":0}
	}`, base.Add(-6*time.Second).UTC().Format(time.RFC3339Nano))
	if err := model.ApplyBridgeEventJSONForTest(payload); err != nil {
		t.Fatalf("set_request_timing failed: %v", err)
	}

	current = base.Add(2500 * time.Millisecond)
	model.ObserveTimeForTest(current)

	footer := ansiPattern.ReplaceAllString(model.RenderBottomStatusBarForTest(160), "")
	if !regexp.MustCompile(`TIME 2\.[0-9]s`).MatchString(footer) {
		t.Fatalf("expected local monotonic timer around 2.5s despite startedAt skew, got %q", footer)
	}
	if strings.Contains(footer, "TIME 8.") {
		t.Fatalf("expected startedAt skew to be ignored, got %q", footer)
	}
}

func TestCustomProviderNameRendersInFooter(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 32
	model.CurrentProvider = "https://code.newcli.com/codex/v1"
	model.CurrentProviderFormat = "gemini_generate_content"
	model.ProviderNames = map[string]string{
		"https://code.newcli.com/codex/v1": "Work Relay",
	}

	view := model.View()
	plainView := ansiPattern.ReplaceAllString(view, "")

	if !strings.Contains(plainView, "PROVIDER Work Relay") {
		t.Fatalf("expected custom provider name in footer, got %q", view)
	}
	if strings.Contains(plainView, "FORMAT Gemini Native") {
		t.Fatalf("expected provider format removed from footer, got %q", view)
	}
	if !strings.Contains(plainView, "CACHE") || !strings.Contains(plainView, "STATUS") {
		t.Fatalf("expected prioritized footer metadata in unified status row, got %q", view)
	}
}

func TestProvidersPanelShowsProviderFormat(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 44
	model.ActivePanel = app.PanelProviders
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.CurrentProvider = "https://api.example.com/v1"
	model.CurrentProviderFormat = "openai_responses"
	model.CurrentProviderKeySource = "CYRENE_OPENAI_API_KEY"
	model.AvailableProviders = []string{"https://api.example.com/v1"}
	model.ProviderProfiles = map[string]string{
		"https://api.example.com/v1": "openai",
	}
	model.ProviderEndpoints = map[string]map[string]string{
		"https://api.example.com/v1": {
			"responses": "/responses",
			"models":    "https://catalog.example.com/models",
		},
	}
	model.ProviderProfileSources = map[string]string{
		"https://api.example.com/v1": "manual",
	}

	view := model.View()

	if !strings.Contains(view, "format OpenAI Responses") {
		t.Fatalf("expected provider format in panel detail, got %q", view)
	}
	if !strings.Contains(view, "profile OpenAI-compatible  |  format") {
		t.Fatalf("expected provider format in panel list, got %q", view)
	}
	if strings.Contains(view, "provider profile commands:") || strings.Contains(view, "endpoint kinds:") {
		t.Fatalf("expected provider command hints removed from panel, got %q", view)
	}
	if !strings.Contains(view, "responses  /responses") {
		t.Fatalf("expected provider endpoint override in panel detail, got %q", view)
	}
	if !strings.Contains(view, "models     https://catalog.example.com/models") {
		t.Fatalf("expected provider models endpoint override in panel detail, got %q", view)
	}
}

func TestProvidersPanelSelectedEntryUsesInverseHighlight(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Width = 170
	model.Height = 44
	model.ActivePanel = app.PanelProviders
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.AvailableProviders = []string{"https://relay.example.com/v1", "https://backup.example.com/v1"}
	model.ProviderIndex = 0
	model.ProviderProfiles = map[string]string{
		"https://relay.example.com/v1":  "openai",
		"https://backup.example.com/v1": "openai",
	}
	model.ProviderFormats = map[string]string{
		"https://relay.example.com/v1":  "openai_responses",
		"https://backup.example.com/v1": "openai_chat",
	}
	model.ProviderProfileSources = map[string]string{
		"https://relay.example.com/v1":  "manual",
		"https://backup.example.com/v1": "manual",
	}
	model.ProviderNames = map[string]string{
		"https://relay.example.com/v1": "Work Relay",
	}

	view := model.View()

	assertLineUsesInverseSelection(t, view, "> Work Relay")
	assertLineUsesInverseSelection(t, view, "   endpoint relay.example.com/v1  |  source manual")
	assertLineUsesInverseSelection(t, view, "   profile OpenAI-compatible  |  format OpenAI Responses")
}

func TestAssistantToolProtocolLeakIsHiddenFromTranscript(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 32
	model.Items = []app.Message{
		{
			Role: "assistant",
			Kind: "transcript",
			Text: "先看看。\n<invoke name=\"read_files\">\n<parameter name=\"path\">src/a.ts</parameter>\n</invoke>\n已处理。",
		},
	}

	view := model.View()

	if strings.Contains(view, "<invoke") || strings.Contains(view, "<parameter") {
		t.Fatalf("expected leaked tool protocol lines hidden from transcript, got %q", view)
	}
	if !strings.Contains(view, "先看看。") || !strings.Contains(view, "已处理。") {
		t.Fatalf("expected surrounding assistant text preserved, got %q", view)
	}
}

func TestComposerShowsSmartCommandMatches(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 32
	model.Input = []rune("/pro")
	model.Cursor = len(model.Input)

	view := model.View()

	if !strings.Contains(view, "┃") {
		t.Fatalf("expected compact slash suggestion block inside composer rail, got %q", view)
	}
	if !strings.Contains(view, "/provider") {
		t.Fatalf("expected provider command in matches, got %q", view)
	}
}

func TestTranscriptHidesLeakedToolJSONPayload(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 32
	model.Items = []app.Message{
		{
			Role: "assistant",
			Kind: "transcript",
			Text: "先看看。\n{\"action\":\"apply_patch\",\"path\":\"simplex.py\",\"find\":\"alpha\",\"replace\":\"beta\"} to=functions.file\n已处理。",
		},
	}

	view := model.View()

	if strings.Contains(view, "\"action\":\"apply_patch\"") || strings.Contains(view, "to=functions.file") {
		t.Fatalf("expected leaked tool JSON payload hidden from transcript, got %q", view)
	}
	if !strings.Contains(view, "先看看。") || !strings.Contains(view, "已处理。") {
		t.Fatalf("expected surrounding assistant text preserved, got %q", view)
	}
}

func TestToolStatusHidesLeakedToolJSONPayload(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 20
	model.Items = []app.Message{
		{
			Role: "system",
			Kind: "tool_status",
			Text: "Tool: read_range simplex.py | range content hidden\n{\"action\":\"apply_patch\",\"path\":\"simplex.py\",\"find\":\"alpha\",\"replace\":\"beta\"} to=functions.file",
		},
	}

	view := model.View()

	if strings.Contains(view, "\"action\":\"apply_patch\"") || strings.Contains(view, "to=functions.file") {
		t.Fatalf("expected leaked tool JSON payload hidden from tool status, got %q", view)
	}
	plainView := ansiPattern.ReplaceAllString(view, "")
	if !strings.Contains(plainView, "read read_range") || !strings.Contains(plainView, "simplex.py | range content hidden") {
		t.Fatalf("expected visible tool status preserved, got %q", view)
	}
}

func TestEscapeClosesPanelWithoutClosedNotice(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 28
	model.ActivePanel = app.PanelSessions
	model.Sessions = []app.BridgeSession{
		{ID: "sess-1", Title: "Current session", UpdatedAt: "2026-04-11T00:00:00Z"},
	}

	model.Update(tea.KeyMsg{Type: tea.KeyEscape})

	if model.ActivePanel != app.PanelNone {
		t.Fatalf("expected panel closed, got %q", model.ActivePanel)
	}
	if model.Notice != "" {
		t.Fatalf("expected panel close to be silent, got %q", model.Notice)
	}

	view := model.View()
	if strings.Contains(view, "Panel closed.") {
		t.Fatalf("expected panel closed notice hidden from composer, got %q", view)
	}
	if !strings.Contains(view, "❯ Ask Cyrene, add images with Ctrl+O, use / commands, or mention files with @...") {
		t.Fatalf("expected default composer prompt after closing panel, got %q", view)
	}
}

func TestWheelScrollMovesSessionSelectionWhenPanelOpen(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 40
	model.ActivePanel = app.PanelSessions
	model.Sessions = []app.BridgeSession{
		{ID: "s1", Title: "one"},
		{ID: "s2", Title: "two"},
	}
	x, y, ok := model.PanelItemMousePointForTest(0, 0)
	if !ok {
		t.Fatalf("expected session panel mouse point")
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonWheelDown,
		Action: tea.MouseActionPress,
		X:      x,
		Y:      y,
	})

	if model.SessionIndex != 1 {
		t.Fatalf("expected session index 1, got %d", model.SessionIndex)
	}
}

func TestWheelScrollMovesApprovalPreviewWhenPanelOpen(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 40
	model.ActivePanel = app.PanelApprovals
	model.PendingReviews = []app.BridgeReview{{
		ID:          "r-1",
		Action:      "edit_file",
		Path:        "a.txt",
		PreviewFull: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22",
	}}
	x, y, ok := model.ApprovalPreviewMousePointForTest()
	if !ok {
		t.Fatalf("expected approval preview mouse point")
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonWheelDown,
		Action: tea.MouseActionPress,
		X:      x,
		Y:      y,
	})

	if model.ApprovalPreviewOffset != 2 {
		t.Fatalf("expected approval preview offset 2, got %d", model.ApprovalPreviewOffset)
	}
}

func TestTranscriptMouseRegionHiddenWhenNavigationPanelIsOpen(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 40
	model.ActivePanel = app.PanelSessions
	model.TranscriptOffset = 10
	model.Items = []app.Message{
		{Role: "user", Kind: "transcript", Text: strings.Repeat("line\n", 20)},
		{Role: "assistant", Kind: "transcript", Text: strings.Repeat("reply\n", 20)},
	}
	x, y, ok := model.TranscriptMousePointForTest()
	if ok || x != 0 || y != 0 {
		t.Fatalf("expected transcript mouse region hidden by full-page panel, got ok=%t x=%d y=%d", ok, x, y)
	}
}

func TestWheelOverComposerDoesNothing(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 28
	model.TranscriptOffset = 10
	x, y, ok := model.ComposerMousePointForTest()
	if !ok {
		t.Fatalf("expected composer mouse point")
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonWheelDown,
		Action: tea.MouseActionPress,
		X:      x,
		Y:      y,
	})

	if model.TranscriptOffset != 10 {
		t.Fatalf("expected composer wheel to leave transcript offset unchanged, got %d", model.TranscriptOffset)
	}
}

func TestTranscriptScrollbarDragMovesViewport(t *testing.T) {
	model := app.NewModel()
	model.Width = 100
	model.Height = 24
	model.Items = []app.Message{
		{Role: "assistant", Kind: "transcript", Text: strings.Repeat("line\n", 80)},
	}

	startX, startY, ok := model.TranscriptScrollbarThumbMousePointForTest()
	if !ok {
		t.Fatalf("expected transcript scrollbar thumb point")
	}
	endX, endY, ok := model.TranscriptScrollbarTrackMousePointForTest(0)
	if !ok {
		t.Fatalf("expected transcript scrollbar track point")
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonLeft,
		Action: tea.MouseActionPress,
		X:      startX,
		Y:      startY,
	})
	model.Update(tea.MouseMsg{
		Action: tea.MouseActionMotion,
		X:      endX,
		Y:      endY,
	})
	model.Update(tea.MouseMsg{
		Action: tea.MouseActionRelease,
		X:      endX,
		Y:      endY,
	})

	if model.TranscriptOffset <= 0 {
		t.Fatalf("expected transcript drag to move viewport away from live tail, got %d", model.TranscriptOffset)
	}
}

func TestSessionScrollbarDragMovesPageSelection(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 40
	model.Status = app.StatusIdle
	model.ActivePanel = app.PanelSessions
	for index := 0; index < 24; index++ {
		model.Sessions = append(model.Sessions, app.BridgeSession{
			ID:    "s" + string(rune('a'+index)),
			Title: "session",
		})
	}

	startX, startY, ok := model.PanelScrollbarThumbMousePointForTest()
	if !ok {
		t.Fatalf("expected session scrollbar thumb point")
	}
	endX, endY, ok := model.PanelScrollbarTrackMousePointForTest(999)
	if !ok {
		t.Fatalf("expected session scrollbar track point")
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonLeft,
		Action: tea.MouseActionPress,
		X:      startX,
		Y:      startY,
	})
	model.Update(tea.MouseMsg{
		Action: tea.MouseActionMotion,
		X:      endX,
		Y:      endY,
	})
	model.Update(tea.MouseMsg{
		Action: tea.MouseActionRelease,
		X:      endX,
		Y:      endY,
	})

	if model.SessionIndex <= 0 {
		t.Fatalf("expected session drag to move selection to a later page, got %d", model.SessionIndex)
	}
	if strings.Contains(model.Notice, "Loading selected session") {
		t.Fatalf("expected scrollbar drag to avoid loading a session, got notice %q", model.Notice)
	}
}

func TestApprovalPreviewScrollbarDragMovesPreviewOffset(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 40
	model.ActivePanel = app.PanelApprovals
	model.PendingReviews = []app.BridgeReview{{
		ID:          "r-1",
		Action:      "edit_file",
		Path:        "a.txt",
		PreviewFull: strings.Repeat("line\n", 60),
	}}

	startX, startY, ok := model.PanelScrollbarThumbMousePointForTest()
	if !ok {
		t.Fatalf("expected approval preview scrollbar thumb point")
	}
	endX, endY, ok := model.PanelScrollbarTrackMousePointForTest(999)
	if !ok {
		t.Fatalf("expected approval preview scrollbar track point")
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonLeft,
		Action: tea.MouseActionPress,
		X:      startX,
		Y:      startY,
	})
	model.Update(tea.MouseMsg{
		Action: tea.MouseActionMotion,
		X:      endX,
		Y:      endY,
	})
	model.Update(tea.MouseMsg{
		Action: tea.MouseActionRelease,
		X:      endX,
		Y:      endY,
	})

	if model.ApprovalPreviewOffset <= 0 {
		t.Fatalf("expected approval preview drag to move offset, got %d", model.ApprovalPreviewOffset)
	}
}

func TestApprovalQueueWheelMovesSelection(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 40
	model.ActivePanel = app.PanelApprovals
	model.PendingReviews = []app.BridgeReview{
		{ID: "r-1", Action: "edit_file", Path: "a.txt"},
		{ID: "r-2", Action: "run_command", Path: "."},
	}
	x, y, ok := model.PanelItemMousePointForTest(0, 0)
	if !ok {
		t.Fatalf("expected approval queue mouse point")
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonWheelDown,
		Action: tea.MouseActionPress,
		X:      x,
		Y:      y,
	})

	if model.ApprovalIndex != 1 {
		t.Fatalf("expected approval index 1, got %d", model.ApprovalIndex)
	}
}

func TestProviderMouseClickMapsThirdVisualRowToSameItem(t *testing.T) {
	model := app.NewModel()
	model.Width = 170
	model.Height = 60
	model.ActivePanel = app.PanelProviders
	model.ProviderIndex = 1
	model.AvailableProviders = []string{
		"https://api.one.example/v1",
		"https://api.two.example/v1",
	}
	x, y, ok := model.PanelItemMousePointForTest(1, 2)
	if !ok {
		t.Fatalf("expected provider panel mouse point")
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonLeft,
		Action: tea.MouseActionPress,
		X:      x,
		Y:      y,
	})

	if model.ProviderIndex != 1 {
		t.Fatalf("expected provider index 1, got %d", model.ProviderIndex)
	}
}

func TestSessionPickerDoubleClickLoadsSelectedSession(t *testing.T) {
	model := app.NewModel()
	model.Width = 170
	model.Height = 40
	model.Status = app.StatusIdle
	model.ActivePanel = app.PanelSessions
	model.Sessions = []app.BridgeSession{
		{ID: "s1", Title: "one"},
		{ID: "s2", Title: "two"},
	}
	x, y, ok := model.PanelItemMousePointForTest(1, 0)
	if !ok {
		t.Fatalf("expected session panel mouse point")
	}
	msg := tea.MouseMsg{
		Button: tea.MouseButtonLeft,
		Action: tea.MouseActionPress,
		X:      x,
		Y:      y,
	}

	model.Update(msg)
	model.Update(msg)

	if model.SessionIndex != 1 {
		t.Fatalf("expected session index 1, got %d", model.SessionIndex)
	}
	if model.Status != app.StatusPreparing {
		t.Fatalf("expected preparing status after double click, got %q", model.Status)
	}
	if model.Notice != "" {
		t.Fatalf("expected low-value load notice suppressed, got %q", model.Notice)
	}
}

func TestSessionPickerReleaseAfterPressDoesNotLoseSelection(t *testing.T) {
	model := app.NewModel()
	model.Width = 170
	model.Height = 40
	model.ActivePanel = app.PanelSessions
	model.Sessions = []app.BridgeSession{
		{ID: "s1", Title: "one"},
		{ID: "s2", Title: "two"},
	}
	x, y, ok := model.PanelItemMousePointForTest(1, 0)
	if !ok {
		t.Fatalf("expected session panel mouse point")
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonLeft,
		Action: tea.MouseActionPress,
		X:      x,
		Y:      y,
	})
	model.Update(tea.MouseMsg{
		Action: tea.MouseActionRelease,
		X:      x,
		Y:      y,
	})

	if model.SessionIndex != 1 {
		t.Fatalf("expected session index 1 after release path, got %d", model.SessionIndex)
	}
}

func TestPlanMouseDoubleClickOnlySelectsStep(t *testing.T) {
	model := app.NewModel()
	model.Width = 170
	model.Height = 40
	model.Status = app.StatusIdle
	model.ActivePanel = app.PanelPlans
	model.ExecutionPlan = app.ExecutionPlan{
		Summary: "Ship mouse support",
		Steps: []app.ExecutionPlanStep{
			{ID: "step-1", Title: "Patch mouse handlers", Status: "pending"},
			{ID: "step-2", Title: "Add tests", Status: "pending"},
		},
	}
	x, y, ok := model.PanelItemMousePointForTest(1, 0)
	if !ok {
		t.Fatalf("expected plan panel mouse point")
	}
	msg := tea.MouseMsg{
		Button: tea.MouseButtonLeft,
		Action: tea.MouseActionPress,
		X:      x,
		Y:      y,
	}

	model.Update(msg)
	model.Update(msg)

	if model.PlanIndex != 1 {
		t.Fatalf("expected plan index 1, got %d", model.PlanIndex)
	}
	if model.Status != app.StatusIdle {
		t.Fatalf("expected plan double click to avoid execution, got %q", model.Status)
	}
	if strings.Contains(model.Notice, "Running selected execution plan step") {
		t.Fatalf("expected no run notice on plan double click, got %q", model.Notice)
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

func TestAuthDigitsInsertIntoFieldWithoutAlt(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelAuth
	model.AuthStep = app.AuthStepAPIKey
	model.AuthCursor = 0

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("abc123xyz")})

	if got := string(model.AuthAPIKey); got != "abc123xyz" {
		t.Fatalf("expected API key field to receive pasted digits, got %q", got)
	}
	if model.AuthStep != app.AuthStepAPIKey {
		t.Fatalf("expected auth step to stay on api key, got %q", model.AuthStep)
	}
}

func TestCtrlVPastesIntoAuthField(t *testing.T) {
	restore := app.SetClipboardReaderForTest(func() (string, error) {
		return "sk-\ufeffabc123", nil
	})
	defer restore()

	model := app.NewModel()
	model.ActivePanel = app.PanelAuth
	model.AuthStep = app.AuthStepAPIKey
	model.AuthCursor = 0

	model.Update(tea.KeyMsg{Type: tea.KeyCtrlV})

	if got := string(model.AuthAPIKey); got != "sk-abc123" {
		t.Fatalf("expected ctrl+v to paste into api key field, got %q", got)
	}
}

func TestAuthAltDigitStillSwitchesField(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelAuth
	model.AuthStep = app.AuthStepAPIKey
	model.AuthModel = []rune("deepseek-reasoner")
	model.AuthCursor = 0

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'4'}, Alt: true})

	if model.AuthStep != app.AuthStepModel {
		t.Fatalf("expected alt+4 to switch to model field, got %q", model.AuthStep)
	}
	if model.AuthCursor != len(model.AuthModel) {
		t.Fatalf("expected cursor at model field end, got %d", model.AuthCursor)
	}
}

func TestAuthPanelHeaderMentionsAltDigitJump(t *testing.T) {
	model := app.NewModel()
	model.Width = 150
	model.Height = 36
	model.ActivePanel = app.PanelAuth

	view := model.View()

	if !strings.Contains(view, "ALT+1-4") {
		t.Fatalf("expected auth header to mention alt digit jump, got %q", view)
	}
}

func TestAuthPanelSelectedEntryUsesInverseHighlight(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Width = 150
	model.Height = 36
	model.ActivePanel = app.PanelAuth
	model.AuthProvider = []rune("https://api.example.com/v1")
	model.AuthProviderType = []rune("openai-compatible")
	model.AuthAPIKey = []rune("sk-live")
	model.AuthModel = []rune("gpt-5.4")
	model.AuthStep = app.AuthStepAPIKey

	view := model.View()
	assertLineUsesInverseSelection(t, view, "[3] API Key  *******")

	model.AuthStep = app.AuthStepConfirm
	view = model.View()
	assertLineUsesInverseSelection(t, view, "[5] Confirm and connect")
}

func TestAuthErrorRendersInsideLoginPanelWhenComposerHidden(t *testing.T) {
	model := app.NewModel()
	model.Width = 150
	model.Height = 36
	model.ActivePanel = app.PanelAuth
	model.AuthSaving = true

	err := model.ApplyBridgeEventJSONForTest(`{
		"type":"error",
		"message":"login failed: invalid API key"
	}`)
	if err != nil {
		t.Fatalf("ApplyBridgeEventJSONForTest returned error: %v", err)
	}

	view := model.View()
	plainView := ansiPattern.ReplaceAllString(view, "")
	if !strings.Contains(plainView, "ERROR") || !strings.Contains(plainView, "login failed: invalid API key") {
		t.Fatalf("expected login error inside auth panel, got %q", view)
	}
	if strings.Contains(plainView, "❯ Ask Cyrene") {
		t.Fatalf("expected auth panel to keep composer hidden, got %q", view)
	}

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("x")})
	if model.AuthError != "" {
		t.Fatalf("expected editing auth field to clear auth error, got %q", model.AuthError)
	}
}

func TestAuthControlRunesAreIgnored(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelAuth
	model.AuthStep = app.AuthStepAPIKey
	model.AuthCursor = 0

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'s', 'k', 0x16, 0x03, '-', '1'}})

	if got := string(model.AuthAPIKey); got != "sk-1" {
		t.Fatalf("expected control runes ignored in auth input, got %q", got)
	}
}

func TestAuthEnterFromAPIKeySkipsPrefilledModelToConfirm(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelAuth
	model.AuthStep = app.AuthStepAPIKey
	model.AuthAPIKey = []rune("sk-live")
	model.AuthModel = []rune("gpt-5.4")
	model.AuthCursor = len(model.AuthAPIKey)

	model.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if model.AuthStep != app.AuthStepConfirm {
		t.Fatalf("expected auth enter to jump to confirm, got %q", model.AuthStep)
	}
	if model.AuthCursor != 0 {
		t.Fatalf("expected confirm cursor reset, got %d", model.AuthCursor)
	}
}

func TestIncrementalBridgeInitHydratesState(t *testing.T) {
	model := app.NewModel()

	err := model.ApplyBridgeEventJSONForTest(`{
		"type":"init",
		"snapshot":{
			"appRoot":"/workspace/demo",
			"status":"idle",
			"activeSessionId":"sess-1",
			"items":[{"role":"user","kind":"transcript","text":"hello"}],
			"liveText":"draft",
			"requestTiming":{"active":false,"startedAt":"2026-04-21T00:00:00Z","elapsedMs":65000},
			"pendingReviews":[{"id":"rev-1","action":"edit_file","path":"a.txt","previewSummary":"sum","previewFull":"full","createdAt":"2026-04-11T00:00:00Z"}],
			"sessions":[{"id":"sess-1","title":"Demo","updatedAt":"2026-04-11T00:00:00Z","projectRoot":"/workspace/demo","tags":["x"]}],
			"currentModel":"gpt-5.4",
			"currentProvider":"https://api.example.com/v1",
			"currentProviderFormat":"openai_responses",
			"currentProviderKeySource":"env",
			"availableModels":["gpt-5.4","gpt-5.3"],
			"availableProviders":["https://api.example.com/v1"],
			"providerProfiles":{"https://api.example.com/v1":"openai"},
			"providerFormats":{"https://api.example.com/v1":"openai_responses"},
			"providerProfileSources":{"https://api.example.com/v1":"manual"},
			"auth":{"mode":"http","credentialSource":"env","provider":"https://api.example.com/v1","model":"gpt-5.4","persistenceLabel":"env","persistencePath":"","httpReady":true,"onboardingAvailable":false}
		}
	}`)
	if err != nil {
		t.Fatalf("ApplyBridgeEventJSONForTest returned error: %v", err)
	}

	if !model.BridgeReady {
		t.Fatalf("expected bridge ready after init")
	}
	if model.ActiveSessionID != "sess-1" {
		t.Fatalf("expected active session hydrated, got %q", model.ActiveSessionID)
	}
	if len(model.Sessions) != 1 || model.Sessions[0].ProjectRoot != "/workspace/demo" {
		t.Fatalf("expected session project root hydrated, got %#v", model.Sessions)
	}
	if len(model.Items) != 1 || model.Items[0].Text != "hello" {
		t.Fatalf("expected transcript hydrated, got %#v", model.Items)
	}
	if model.LiveText != "draft" {
		t.Fatalf("expected live text hydrated, got %q", model.LiveText)
	}
	if len(model.PendingReviews) != 1 || model.PendingReviews[0].ID != "rev-1" {
		t.Fatalf("expected pending reviews hydrated, got %#v", model.PendingReviews)
	}
	if model.CurrentModel != "gpt-5.4" || model.CurrentProviderKeySource != "env" {
		t.Fatalf("expected runtime metadata hydrated, got model=%q keySource=%q", model.CurrentModel, model.CurrentProviderKeySource)
	}
	if model.CurrentProviderFormat != "openai_responses" {
		t.Fatalf("expected provider format hydrated, got %q", model.CurrentProviderFormat)
	}
	if model.RequestTimingActive {
		t.Fatalf("expected hydrated request timer to be inactive")
	}
	if model.RequestTimingElapsedMs != 65000 {
		t.Fatalf("expected hydrated request timer elapsed ms, got %d", model.RequestTimingElapsedMs)
	}
	if model.ProviderFormats["https://api.example.com/v1"] != "openai_responses" {
		t.Fatalf("expected provider format overrides hydrated, got %#v", model.ProviderFormats)
	}
}

func TestIncrementalBridgeAppendReplaceAndLiveText(t *testing.T) {
	model := app.NewModel()
	if err := model.ApplyBridgeEventJSONForTest(`{"type":"replace_items","items":[{"role":"user","kind":"transcript","text":"one"}]}`); err != nil {
		t.Fatalf("replace_items failed: %v", err)
	}
	if err := model.ApplyBridgeEventJSONForTest(`{"type":"append_items","items":[{"role":"assistant","kind":"transcript","text":"two"},{"role":"system","kind":"tool_status","text":"three"}]}`); err != nil {
		t.Fatalf("append_items failed: %v", err)
	}
	if err := model.ApplyBridgeEventJSONForTest(`{"type":"set_live_text","liveText":"streaming"}`); err != nil {
		t.Fatalf("set_live_text failed: %v", err)
	}

	if len(model.Items) != 3 {
		t.Fatalf("expected 3 transcript items, got %d", len(model.Items))
	}
	if model.Items[1].Text != "two" {
		t.Fatalf("expected appended item, got %#v", model.Items[1])
	}
	if model.Items[2].Text != "three" {
		t.Fatalf("expected batched appended item, got %#v", model.Items[2])
	}
	if model.LiveText != "streaming" {
		t.Fatalf("expected live text updated, got %q", model.LiveText)
	}
}

func TestBridgeResetEventsRequestTerminalClear(t *testing.T) {
	model := app.NewModel()

	clear, err := model.ApplyBridgeEventJSONNeedsClearForTest(`{"type":"init","snapshot":{"status":"idle","items":[{"role":"system","kind":"system_hint","text":"No messages in the current session. Start typing."}]}}`)
	if err != nil {
		t.Fatalf("init failed: %v", err)
	}
	if !clear {
		t.Fatalf("expected init snapshot to request terminal clear")
	}

	clear, err = model.ApplyBridgeEventJSONNeedsClearForTest(`{"type":"replace_items","items":[{"role":"user","kind":"transcript","text":"new session"}]}`)
	if err != nil {
		t.Fatalf("replace_items failed: %v", err)
	}
	if !clear {
		t.Fatalf("expected replace_items to request terminal clear")
	}

	clear, err = model.ApplyBridgeEventJSONNeedsClearForTest(`{"type":"append_items","items":[{"role":"assistant","kind":"transcript","text":"incremental"}]}`)
	if err != nil {
		t.Fatalf("append_items failed: %v", err)
	}
	if clear {
		t.Fatalf("expected append_items to avoid terminal clear")
	}

	clear, err = model.ApplyBridgeEventJSONNeedsClearForTest(`{"type":"set_live_text","liveText":"streaming"}`)
	if err != nil {
		t.Fatalf("set_live_text failed: %v", err)
	}
	if clear {
		t.Fatalf("expected live text updates to avoid terminal clear")
	}
}

func TestBridgeResetEventsEmitClearScreenCommand(t *testing.T) {
	model := app.NewModel()

	cmd, err := model.UpdateBridgeEventJSONForTest(`{"type":"init","snapshot":{"status":"idle","items":[{"role":"system","kind":"system_hint","text":"No messages in the current session. Start typing."}]}}`)
	if err != nil {
		t.Fatalf("init failed: %v", err)
	}
	if !commandEmitsClearScreen(cmd) {
		t.Fatalf("expected init snapshot Update command to emit Bubble Tea clear-screen message")
	}

	cmd, err = model.UpdateBridgeEventJSONForTest(`{"type":"replace_items","items":[{"role":"user","kind":"transcript","text":"new session"}]}`)
	if err != nil {
		t.Fatalf("replace_items failed: %v", err)
	}
	if !commandEmitsClearScreen(cmd) {
		t.Fatalf("expected replace_items Update command to emit Bubble Tea clear-screen message")
	}

	cmd, err = model.UpdateBridgeEventJSONForTest(`{"type":"append_items","items":[{"role":"assistant","kind":"transcript","text":"incremental"}]}`)
	if err != nil {
		t.Fatalf("append_items failed: %v", err)
	}
	if commandEmitsClearScreen(cmd) {
		t.Fatalf("expected append_items Update command to avoid clear-screen message")
	}
}

func TestANSILinesWrapInNarrowWidthWithoutDroppingContent(t *testing.T) {
	line := "\x1b[31malpha beta gamma delta epsilon\x1b[0m"
	rows := app.WrapLinesToWidthForTest([]string{line}, 10)
	if len(rows) < 3 {
		t.Fatalf("expected ANSI line to wrap into multiple rows, got %#v", rows)
	}

	plainRows := make([]string, 0, len(rows))
	for _, row := range rows {
		width := app.RenderedLineWidthForTest(row)
		if width > 10 {
			t.Fatalf("expected wrapped row width <= 10, got %d for %q", width, row)
		}
		plainRows = append(plainRows, ansiPattern.ReplaceAllString(row, ""))
	}
	if got, want := strings.Join(strings.Fields(strings.Join(plainRows, " ")), " "), "alpha beta gamma delta epsilon"; got != want {
		t.Fatalf("expected ANSI wrap to preserve full content, got %q want %q in %#v", got, want, rows)
	}
}

func TestSingleSystemResultDoesNotKeepStartupSplash(t *testing.T) {
	model := app.NewModel()

	if err := model.ApplyBridgeEventJSONForTest(`{"type":"replace_items","items":[{"role":"system","kind":"system_hint","text":"MCP runtime summary\nservers: 2"}]}`); err != nil {
		t.Fatalf("replace_items failed: %v", err)
	}

	rendered := model.RenderTranscriptForTest(80, 16)
	if !strings.Contains(rendered, "MCP runtime summary") {
		t.Fatalf("expected transcript to show MCP summary, got %q", rendered)
	}
	if strings.Contains(rendered, "No transcript yet.") {
		t.Fatalf("expected startup splash hidden once real system content exists, got %q", rendered)
	}
}

func TestViewClampsMixedTranscriptLayoutToTerminalBounds(t *testing.T) {
	enableColorRenderingForTest(t)

	model := app.NewModel()
	model.Width = 165
	model.Height = 20
	model.GitBranch = "master"
	model.AppRoot = "/home/administrator/Cyrene-code"
	model.CurrentModel = "deepseek-v4-flash"
	model.CurrentProvider = "openai"
	model.Status = app.StatusIdle
	model.Items = []app.Message{
		{Role: "system", Kind: "tool_status", Text: "Tool: read_file bin/lib/cyrene-cli.js | content hidden"},
		{Role: "user", Kind: "transcript", Text: "你好,看看项目结构"},
		{Role: "system", Kind: "tool_status", Text: "Tool: list_dir . | confirmed directory state | [F] SECURITY.md, [D] bin, [D] .cursor, [F] Dockerfile (26 items, +22 more)"},
		{Role: "system", Kind: "tool_status", Text: "Tool: read_file package.json | content hidden"},
		{Role: "system", Kind: "tool_status", Text: "Tool: read_file tsconfig.json | content hidden"},
		{Role: "assistant", Kind: "transcript", Text: strings.Join([]string{
			"Cyrene 项目结构总览",
			"",
			"概览",
			"",
			"Cyrene 是一个混合架构的 CLI 工具，由 Node.js 和 Go 两部分组成。Node.js 部分负责配置管理、CLI 参数解析和启动桥接，Go 部分运行基于 BubbleTea（Go TUI 框架）的主交互界面。",
			"",
			"入口与启动链",
			"",
			"```",
			"bin/cyrene.js            <- 入口点",
			"  handleCyreneCli()      <- bin/lib/cyrene-cli.js 处理 CLI 参数",
			"```",
			"",
			"源码核心模块（`src/` 目录）",
			"",
			"| 模块 | 职责 |",
			"| --- | --- |",
			"| core/query/ | runQuerySession、QueryTransport、StreamEvent、ToolCallFrame、SessionMachine |",
			"| core/execution/ | ExecutionRuntime、ExecutionSnapshot、ToolObservationStore、ProgressTracker |",
			"| core/session/ | SessionStore、SessionRecord、SessionMessage、buildPromptWithContext、stateReducer、pendingChoice、workingState |",
			"| core/mcp/ | McpManager、McpToolRouter、McpPolicy、createMcpRuntime、builtinTools、toolTypes |",
			"| core/skills/ | SkillsRuntime、SkillDefinition、chooseSkillCreationTask、detectStableSkillPattern、parseAssistantSkillUpdate |",
			"| core/extensions/ | createExtensionManager、ExtensionManager |",
			"",
			"3️⃣ 基础设施层 — `src/infra/`",
			"",
			"| 模块 | 职责 |",
			"| --- | --- |",
			"| infra/config/ | appRoot、loadCyreneConfig、loadPromptPolicy、CyreneConfig、PromptPolicy |",
			"| infra/auth/ | createAuthRuntime、AuthRuntime、AuthStatus |",
			"| infra/session/ | createFileSessionStore — 文件级会话存储 |",
			"| infra/http/ | createHttpQueryTransport、normalizeProviderBaseUrl |",
			"",
			"4️⃣ 默认配置（cyrene-cli.js 中）",
			"",
			"```js",
			"DEFAULT_CONFIG = {",
			"  pinMaxCount: 6,",
			"  queryMaxToolSteps: 19200,",
			"  autoSummaryRefresh: true,",
			"  requestTemperature: 0.2,",
			"  debugCaptureAnthropicRequests: false,",
			"}",
			"```",
			"",
			"5️⃣ Provider 支持",
			"",
			"| 别名 | 实际端点 |",
			"| --- | --- |",
			"| openai | https://api.openai.com/v1 |",
			"| gemini | https://generativelanguage.googleapis.com/v1beta/openai |",
			"| anthropic / claude | https://api.anthropic.com |",
			"| custom | 用户自定义 |",
		}, "\n")},
	}

	view := model.View()
	lines := strings.Split(view, "\n")
	stripANSI := regexp.MustCompile(`\x1b\[[0-9;]*m`)

	if len(lines) > model.Height {
		t.Fatalf("expected rendered height <= %d, got %d in %q", model.Height, len(lines), view)
	}

	for _, line := range lines {
		plain := stripANSI.ReplaceAllString(line, "")
		if app.RenderedLineWidthForTest(plain) > model.Width {
			t.Fatalf("expected line width <= %d, got %d for %q in %q", model.Width, app.RenderedLineWidthForTest(plain), plain, view)
		}
	}
}

func TestIncrementalBridgeSessionsAndMetadata(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelAuth
	model.AuthSaving = true

	if err := model.ApplyBridgeEventJSONForTest(`{
		"type":"set_sessions",
		"sessions":[
			{"id":"sess-1","title":"One","updatedAt":"2026-04-11T00:00:00Z","tags":[]},
			{"id":"sess-2","title":"Two","updatedAt":"2026-04-11T00:01:00Z","tags":["keep"]}
		],
		"activeSessionId":"sess-2"
	}`); err != nil {
		t.Fatalf("set_sessions failed: %v", err)
	}
	if err := model.ApplyBridgeEventJSONForTest(`{
		"type":"set_runtime_metadata",
		"appRoot":"/workspace/project-b",
		"auth":{"mode":"http","credentialSource":"env","provider":"https://provider/v1","model":"gpt-5.4","persistenceLabel":"env","persistencePath":"","httpReady":true,"onboardingAvailable":false},
		"currentModel":"gpt-5.4",
		"currentProvider":"https://provider/v1",
		"currentProviderFormat":"gemini_generate_content",
		"currentProviderKeySource":"env",
		"availableModels":["gpt-5.4"],
		"availableProviders":["https://provider/v1"],
		"providerProfiles":{"https://provider/v1":"openai"},
		"providerFormats":{"https://provider/v1":"gemini_generate_content"},
		"providerProfileSources":{"https://provider/v1":"manual"}
	}`); err != nil {
		t.Fatalf("set_runtime_metadata failed: %v", err)
	}

	if model.ActiveSessionID != "sess-2" || model.SessionIndex != 1 {
		t.Fatalf("expected sessions selection synced, got active=%q index=%d", model.ActiveSessionID, model.SessionIndex)
	}
	if model.AppRoot != "/workspace/project-b" {
		t.Fatalf("expected app root updated, got %q", model.AppRoot)
	}
	if model.CurrentProviderFormat != "gemini_generate_content" {
		t.Fatalf("expected provider format updated, got %q", model.CurrentProviderFormat)
	}
	if model.ActivePanel != app.PanelNone {
		t.Fatalf("expected auth panel closed after ready auth, got %q", model.ActivePanel)
	}
	if !strings.Contains(model.Notice, "HTTP login updated") {
		t.Fatalf("expected auth success notice, got %q", model.Notice)
	}
}

func TestUsageSummaryAndExitSummaryText(t *testing.T) {
	model := app.NewModel()
	model.ActiveSessionID = "sess-2"
	model.Sessions = []app.BridgeSession{
		{ID: "sess-2", Title: "Resume work", UpdatedAt: "2026-04-11T00:01:00Z", Tags: []string{}},
	}
	model.AppRoot = "/workspace/project-b"
	model.CurrentModel = "gpt-5.4"
	model.CurrentProvider = "https://code.newcli.com/codex/v1"
	model.ProviderNames = map[string]string{
		"https://code.newcli.com/codex/v1": "Work Relay",
	}

	if err := model.ApplyBridgeEventJSONForTest(`{
		"type":"set_usage_summary",
		"usageSummary":{
			"requests":3,
			"promptTokens":1200,
			"cachedTokens":400,
			"completionTokens":360,
			"totalTokens":1560
		}
	}`); err != nil {
		t.Fatalf("set_usage_summary failed: %v", err)
	}

	summary := model.ExitSummaryText()
	plainSummary := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(summary, "")
	if !strings.Contains(plainSummary, "CYRENE SESSION CLOSED") {
		t.Fatalf("expected terminal-style summary header, got %q", summary)
	}
	if !strings.Contains(plainSummary, "┌") || !strings.Contains(plainSummary, "┘") {
		t.Fatalf("expected boxed summary, got %q", summary)
	}
	if !strings.Contains(plainSummary, "session     sess-2") {
		t.Fatalf("expected session id in summary, got %q", summary)
	}
	if !strings.Contains(plainSummary, "title       Resume work") {
		t.Fatalf("expected session title in summary, got %q", summary)
	}
	if !strings.Contains(plainSummary, "provider    Work Relay") {
		t.Fatalf("expected provider name in summary, got %q", summary)
	}
	if !strings.Contains(plainSummary, "requests    3") || !strings.Contains(plainSummary, "cached      400") {
		t.Fatalf("expected usage counters in summary, got %q", summary)
	}
	if strings.HasSuffix(plainSummary, "\nok") {
		t.Fatalf("expected summary to omit trailing ok, got %q", summary)
	}
}

func TestSetAuthDefaultsHydratesLoginPanelFields(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelAuth

	err := model.ApplyBridgeEventJSONForTest(`{
		"type":"set_auth_defaults",
		"providerBaseUrl":"https://api.example.com/v1",
		"providerType":"openai-compatible",
		"model":"gpt-5.4",
		"apiKey":"sk-live"
	}`)
	if err != nil {
		t.Fatalf("ApplyBridgeEventJSONForTest returned error: %v", err)
	}

	if got := string(model.AuthProvider); got != "https://api.example.com/v1" {
		t.Fatalf("expected auth provider hydrated, got %q", got)
	}
	if got := string(model.AuthProviderType); got != "openai-compatible" {
		t.Fatalf("expected auth provider type hydrated, got %q", got)
	}
	if got := string(model.AuthModel); got != "gpt-5.4" {
		t.Fatalf("expected auth model hydrated, got %q", got)
	}
	if got := string(model.AuthAPIKey); got != "sk-live" {
		t.Fatalf("expected auth api key hydrated, got %q", got)
	}
	if model.AuthStep != app.AuthStepConfirm {
		t.Fatalf("expected auth panel to jump to confirm for prefilled login, got %q", model.AuthStep)
	}
	if model.AuthCursor != 0 {
		t.Fatalf("expected confirm cursor reset, got %d", model.AuthCursor)
	}
}

func TestSetAuthDefaultsFocusesAPIKeyWhenProviderAndModelKnownButKeyMissing(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelAuth

	err := model.ApplyBridgeEventJSONForTest(`{
		"type":"set_auth_defaults",
		"providerBaseUrl":"https://api.example.com/v1",
		"providerType":"openai-compatible",
		"model":"gpt-5.4",
		"apiKey":""
	}`)
	if err != nil {
		t.Fatalf("ApplyBridgeEventJSONForTest returned error: %v", err)
	}

	if model.AuthStep != app.AuthStepAPIKey {
		t.Fatalf("expected auth panel to focus api key, got %q", model.AuthStep)
	}
	if model.AuthCursor != 0 {
		t.Fatalf("expected api key cursor at start, got %d", model.AuthCursor)
	}
}

func TestSetAuthDefaultsFocusesProviderTypeWhenProviderKnownButTypeMissing(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelAuth

	err := model.ApplyBridgeEventJSONForTest(`{
		"type":"set_auth_defaults",
		"providerBaseUrl":"https://api.example.com/v1",
		"providerType":"",
		"model":"gpt-5.4",
		"apiKey":"sk-live"
	}`)
	if err != nil {
		t.Fatalf("ApplyBridgeEventJSONForTest returned error: %v", err)
	}

	if model.AuthStep != app.AuthStepProviderType {
		t.Fatalf("expected auth panel to focus provider type, got %q", model.AuthStep)
	}
	if model.AuthCursor != 0 {
		t.Fatalf("expected provider type cursor at start, got %d", model.AuthCursor)
	}
}

package tests

import (
	"regexp"
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

	if model.TranscriptOffset != 2 {
		t.Fatalf("expected transcript offset 2, got %d", model.TranscriptOffset)
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

func TestCopyModeHelperMentionsRightClickPaste(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 24

	model.Update(tea.KeyMsg{Type: tea.KeyF6})
	model.Notice = ""
	view := model.View()

	if !strings.Contains(view, "right-click paste") {
		t.Fatalf("expected copy mode helper to mention right-click paste, got %q", view)
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
	}

	view := model.View()

	if !strings.Contains(view, "user>") {
		t.Fatalf("expected terminal flow user prefix, got %q", view)
	}
	if !strings.Contains(view, "assistant>") {
		t.Fatalf("expected terminal flow assistant prefix, got %q", view)
	}
	if !strings.Contains(view, "tool>") {
		t.Fatalf("expected terminal flow tool prefix, got %q", view)
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

func TestWideViewShowsTranscriptAndInspector(t *testing.T) {
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

	if !strings.Contains(view, "SESSION") {
		t.Fatalf("expected main session section, got %q", view)
	}
	if !strings.Contains(view, "sessions") {
		t.Fatalf("expected sessions panel content, got %q", view)
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

	if strings.Contains(view, "terminal advantages") {
		t.Fatalf("expected compact startup view when panel is open, got %q", view)
	}
	if !strings.Contains(view, "Startup splash is compressed while the inspector is open.") {
		t.Fatalf("expected compact startup explanation, got %q", view)
	}
	if !strings.Contains(view, "active panel  sessions") {
		t.Fatalf("expected compact startup summary fields, got %q", view)
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
	if !strings.Contains(view, "terminal workspace") {
		t.Fatalf("expected startup splash after live text clears, got %q", view)
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
	bottomBorder := -1
	for index, line := range lines {
		if strings.Contains(line, "SESSIONS") && strings.Contains(line, "TOTAL 3") {
			summaryLine = index
		}
		if strings.Contains(line, "┘") && strings.Contains(line, "└") {
			bottomBorder = index
			break
		}
	}

	if summaryLine < 0 || bottomBorder < 0 {
		t.Fatalf("expected sessions summary/footer lines, got %q", view)
	}
	if bottomBorder-summaryLine != 1 {
		t.Fatalf("expected sessions summary near panel bottom, got %q", view)
	}
}

func TestWidePanelLayoutClosesBothFramesOnSameRow(t *testing.T) {
	model := app.NewModel()
	model.Width = 180
	model.Height = 50
	model.ActivePanel = app.PanelSessions

	view := model.View()

	if !strings.Contains(view, "┘ └") {
		t.Fatalf("expected session pane and side panel to close on the same row, got %q", view)
	}
}

func TestViewUsesSquareBorders(t *testing.T) {
	model := app.NewModel()
	model.Width = 100
	model.Height = 24
	model.ActivePanel = app.PanelSessions
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.Sessions = []app.BridgeSession{
		{ID: "sess-1", Title: "Current session", UpdatedAt: "2026-04-11T00:00:00Z"},
	}

	view := model.View()

	if !strings.Contains(view, "┌") {
		t.Fatalf("expected square border glyphs, got %q", view)
	}
	if strings.Contains(view, "╭") {
		t.Fatalf("expected rounded borders removed, got %q", view)
	}
	if !strings.Contains(view, "╔") {
		t.Fatalf("expected outer special border, got %q", view)
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

	if !strings.Contains(view, "+   12 │") {
		t.Fatalf("expected terminal diff add gutter, got %q", view)
	}
	if !strings.Contains(view, "-   10 │") {
		t.Fatalf("expected terminal diff remove gutter, got %q", view)
	}
}

func TestHeaderMovesCommandHintsToHelp(t *testing.T) {
	model := app.NewModel()
	model.Width = 120
	model.Height = 32
	model.AppRoot = "/workspace/demo/project/very/long/path/example"
	model.CurrentModel = "gpt-5.4"
	model.CurrentProvider = "https://code.newcli.com/codex/v1"
	model.CurrentProviderFormat = "openai_responses"

	view := model.View()

	if strings.Contains(view, "/login  /provider  /model") {
		t.Fatalf("expected command catalog removed from header, got %q", view)
	}
	if !strings.Contains(view, "/help") {
		t.Fatalf("expected /help hint to remain discoverable, got %q", view)
	}
	if !strings.Contains(view, "STATUS") {
		t.Fatalf("expected top status chips, got %q", view)
	}
	headerLine := strings.Split(view, "\n")[1]
	if strings.Contains(headerLine, "MODE ") {
		t.Fatalf("expected MODE chip removed from header, got %q", headerLine)
	}
	if !strings.Contains(view, "PROJECT") || !strings.Contains(view, ".../path/example") {
		t.Fatalf("expected project path to use same chip style, got %q", view)
	}
	if !strings.Contains(view, "SESSION") || !strings.Contains(view, "MODEL") || !strings.Contains(view, "FORMAT") || !strings.Contains(view, "PROVIDER") || !strings.Contains(view, "KEY") {
		t.Fatalf("expected bottom evenly spaced status row, got %q", view)
	}
	if !strings.Contains(view, "PROVIDER Newcli") {
		t.Fatalf("expected provider status to show friendly provider name, got %q", view)
	}
	if !strings.Contains(view, "FORMAT OpenAI Responses") {
		t.Fatalf("expected provider format in footer, got %q", view)
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
	if !strings.Contains(view, "match") || !strings.Contains(view, "also") {
		t.Fatalf("expected richer match/also suggestion rows, got %q", view)
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

	if !strings.Contains(view, "⠸ PREPARING") {
		t.Fatalf("expected animated preparing label, got %q", view)
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

	if !strings.Contains(view, "PROVIDER Work Relay") {
		t.Fatalf("expected custom provider name in footer, got %q", view)
	}
	if !strings.Contains(view, "FORMAT Gemini Native") {
		t.Fatalf("expected provider format in footer, got %q", view)
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
	if !strings.Contains(view, "endpoint kinds:") || !strings.Contains(view, "chat_completions") {
		t.Fatalf("expected provider panel endpoint kind hint, got %q", view)
	}
	if !strings.Contains(view, "responses  /responses") {
		t.Fatalf("expected provider endpoint override in panel detail, got %q", view)
	}
	if !strings.Contains(view, "models     https://catalog.example.com/models") {
		t.Fatalf("expected provider models endpoint override in panel detail, got %q", view)
	}
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

	if !strings.Contains(view, "match") {
		t.Fatalf("expected smart command matching hint, got %q", view)
	}
	if !strings.Contains(view, "/provider") {
		t.Fatalf("expected provider command in matches, got %q", view)
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

func TestWheelOverTranscriptStillScrollsWhenPanelIsOpen(t *testing.T) {
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
	if !ok {
		t.Fatalf("expected transcript mouse point")
	}

	model.Update(tea.MouseMsg{
		Button: tea.MouseButtonWheelDown,
		Action: tea.MouseActionPress,
		X:      x,
		Y:      y,
	})

	if model.TranscriptOffset != 2 {
		t.Fatalf("expected transcript offset 2 with panel open, got %d", model.TranscriptOffset)
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
	if !strings.Contains(model.Notice, "Loading selected session") {
		t.Fatalf("expected load notice after double click, got %q", model.Notice)
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

	if !strings.Contains(view, "ALT+1/2/3/4") {
		t.Fatalf("expected auth header to mention alt digit jump, got %q", view)
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

func TestSingleSystemResultDoesNotKeepStartupSplash(t *testing.T) {
	model := app.NewModel()

	if err := model.ApplyBridgeEventJSONForTest(`{"type":"replace_items","items":[{"role":"system","kind":"system_hint","text":"MCP runtime summary\nservers: 2"}]}`); err != nil {
		t.Fatalf("replace_items failed: %v", err)
	}

	rendered := model.RenderTranscriptForTest(80, 16)
	if !strings.Contains(rendered, "MCP runtime summary") {
		t.Fatalf("expected transcript to show MCP summary, got %q", rendered)
	}
	if strings.Contains(rendered, "terminal workspace") {
		t.Fatalf("expected startup splash hidden once real system content exists, got %q", rendered)
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

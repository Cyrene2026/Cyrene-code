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

func TestWideViewShowsTranscriptAndInspector(t *testing.T) {
	model := app.NewModel()
	model.Width = 160
	model.Height = 60
	model.ActivePanel = app.PanelSessions
	model.ActiveSessionID = "sess-1"
	model.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
	model.Sessions = []app.BridgeSession{
		{ID: "sess-1", Title: "Current session", UpdatedAt: "2026-04-11T00:00:00Z", Tags: []string{"active"}},
		{ID: "sess-2", Title: "Older session", UpdatedAt: "2026-04-10T00:00:00Z"},
	}

	view := model.View()

	if !strings.Contains(view, "SESSION") {
		t.Fatalf("expected main session section, got %q", view)
	}
	if !strings.Contains(view, "sessions") {
		t.Fatalf("expected sessions panel content, got %q", view)
	}
	if !strings.Contains(view, "detail") {
		t.Fatalf("expected detail section, got %q", view)
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
	model.CurrentProvider = "https://code.newcli.com/codex/v1"

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
	if !strings.Contains(view, "SESSION") || !strings.Contains(view, "MODEL") || !strings.Contains(view, "PROVIDER") || !strings.Contains(view, "KEY") {
		t.Fatalf("expected bottom evenly spaced status row, got %q", view)
	}
	if !strings.Contains(view, "PROVIDER Newcli") {
		t.Fatalf("expected provider status to show friendly provider name, got %q", view)
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
	model.ProviderNames = map[string]string{
		"https://code.newcli.com/codex/v1": "Work Relay",
	}

	view := model.View()

	if !strings.Contains(view, "PROVIDER Work Relay") {
		t.Fatalf("expected custom provider name in footer, got %q", view)
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

func TestAuthAltDigitStillSwitchesField(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelAuth
	model.AuthStep = app.AuthStepAPIKey
	model.AuthModel = []rune("deepseek-reasoner")
	model.AuthCursor = 0

	model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'3'}, Alt: true})

	if model.AuthStep != app.AuthStepModel {
		t.Fatalf("expected alt+3 to switch to model field, got %q", model.AuthStep)
	}
	if model.AuthCursor != len(model.AuthModel) {
		t.Fatalf("expected cursor at model field end, got %d", model.AuthCursor)
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
			"sessions":[{"id":"sess-1","title":"Demo","updatedAt":"2026-04-11T00:00:00Z","tags":["x"]}],
			"currentModel":"gpt-5.4",
			"currentProvider":"https://api.example.com/v1",
			"currentProviderKeySource":"env",
			"availableModels":["gpt-5.4","gpt-5.3"],
			"availableProviders":["https://api.example.com/v1"],
			"providerProfiles":{"https://api.example.com/v1":"openai"},
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
		"currentProviderKeySource":"env",
		"availableModels":["gpt-5.4"],
		"availableProviders":["https://provider/v1"],
		"providerProfiles":{"https://provider/v1":"openai"},
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
	if model.ActivePanel != app.PanelNone {
		t.Fatalf("expected auth panel closed after ready auth, got %q", model.ActivePanel)
	}
	if !strings.Contains(model.Notice, "HTTP login updated") {
		t.Fatalf("expected auth success notice, got %q", model.Notice)
	}
}

func TestSetAuthDefaultsHydratesLoginPanelFields(t *testing.T) {
	model := app.NewModel()
	model.ActivePanel = app.PanelAuth

	err := model.ApplyBridgeEventJSONForTest(`{
		"type":"set_auth_defaults",
		"providerBaseUrl":"https://api.example.com/v1",
		"model":"gpt-5.4",
		"apiKey":"sk-live"
	}`)
	if err != nil {
		t.Fatalf("ApplyBridgeEventJSONForTest returned error: %v", err)
	}

	if got := string(model.AuthProvider); got != "https://api.example.com/v1" {
		t.Fatalf("expected auth provider hydrated, got %q", got)
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

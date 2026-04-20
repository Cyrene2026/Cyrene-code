package app

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/charmbracelet/bubbles/cursor"
	"github.com/charmbracelet/bubbles/textarea"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type Status string

type Panel string

type ApprovalPreviewMode string

type AuthStep string

type slashCommandSpec struct {
	Command     string
	Description string
	InsertValue string
}

const (
	StatusIdle           Status = "idle"
	StatusPreparing      Status = "preparing"
	StatusRequesting     Status = "requesting"
	StatusStreaming      Status = "streaming"
	StatusAwaitingReview Status = "awaiting_review"
	StatusError          Status = "error"

	PanelNone      Panel = "none"
	PanelApprovals Panel = "approvals"
	PanelPlans     Panel = "plans"
	PanelSessions  Panel = "sessions"
	PanelModels    Panel = "models"
	PanelProviders Panel = "providers"
	PanelAuth      Panel = "auth"

	ApprovalSummary ApprovalPreviewMode = "summary"
	ApprovalFull    ApprovalPreviewMode = "full"

	AuthStepProvider     AuthStep = "provider"
	AuthStepProviderType AuthStep = "provider_type"
	AuthStepAPIKey       AuthStep = "api_key"
	AuthStepModel        AuthStep = "model"
	AuthStepConfirm      AuthStep = "confirm"

	scrollStep               = 8
	approvalQueuePageSize    = 5
	approvalPreviewPageLines = 20
	mouseDoubleClickWindow   = 400 * time.Millisecond
	rightClickPasteWindow    = 400 * time.Millisecond
	mouseReleaseWindow       = 500 * time.Millisecond
	mouseActivationDedup     = 150 * time.Millisecond
	statusSpinnerInterval    = 120 * time.Millisecond
	slashSuggestionLimit     = 4
)

type statusSpinnerTickMsg struct{}

type ComposerCompositionMsg struct {
	Text   []rune
	Cursor int
}

type ComposerCompositionCommitMsg struct {
	Text []rune
}

type ComposerCompositionClearMsg struct{}

type TerminalCursorAnchor struct {
	Active       bool
	RowsUp       int
	ColumnsRight int
}

var slashCommandCatalog = []slashCommandSpec{
	{Command: "/help", Description: "show command list"},
	{Command: "/login", Description: "open HTTP login panel"},
	{Command: "/logout", Description: "remove managed user auth and rebuild transport"},
	{Command: "/auth", Description: "show auth mode, source, and persistence target"},
	{Command: "/provider", Description: "open provider picker"},
	{Command: "/provider refresh", Description: "refresh current provider models"},
	{Command: "/provider type list", Description: "list manual provider type overrides"},
	{Command: "/provider type <openai-compatible|openai-responses|gemini|anthropic> [url]", Description: "set explicit provider type"},
	{Command: "/provider type clear [url]", Description: "clear explicit provider type override"},
	{Command: "/provider profile list", Description: "list manual provider profile overrides"},
	{Command: "/provider profile <openai|gemini|anthropic|custom> [url]", Description: "override provider profile (custom clears override)"},
	{Command: "/provider profile clear [url]", Description: "clear manual provider profile override"},
	{Command: "/provider format list", Description: "list manual provider transport format overrides"},
	{Command: "/provider format <openai_chat|openai_responses|anthropic_messages|gemini_generate_content> [url]", Description: "override provider transport format"},
	{Command: "/provider format clear [url]", Description: "clear manual provider transport format override"},
	{Command: "/provider endpoint list", Description: "list manual provider endpoint overrides"},
	{Command: "/provider endpoint <responses|chat_completions|models|anthropic_messages|gemini_generate_content> <path|url> [provider]", Description: "override provider endpoint by kind"},
	{Command: "/provider endpoint clear <kind> [provider]", Description: "clear manual provider endpoint override by kind"},
	{Command: "/provider name list", Description: "list custom provider names"},
	{Command: "/provider name <display_name>", Description: "set custom name for current provider"},
	{Command: "/provider name clear [url]", Description: "clear custom provider name"},
	{Command: "/provider <url>", Description: "switch provider directly (also accepts openai/gemini/anthropic)"},
	{Command: "/model", Description: "open model picker"},
	{Command: "/model refresh", Description: "refresh available models"},
	{Command: "/model custom <id>", Description: "switch to a custom model id directly"},
	{Command: "/model <name>", Description: "switch model directly"},
	{Command: "/system", Description: "show current system prompt"},
	{Command: "/system <text>", Description: "set system prompt for this runtime"},
	{Command: "/system reset", Description: "restore default system prompt"},
	{Command: "/state", Description: "show reducer/session state diagnostics"},
	{Command: "/plan create <task>", Description: "create or refresh an execution plan"},
	{Command: "/plan revise <instruction>", Description: "ask AI to revise the active execution plan"},
	{Command: "/plan show", Description: "show the active execution plan"},
	{Command: "/plan summary <text>", Description: "manually set plan summary"},
	{Command: "/plan objective <text>", Description: "manually set plan objective"},
	{Command: "/plan add <title> [:: details]", Description: "manually add a plan step"},
	{Command: "/plan update <step> <title> [:: details]", Description: "manually edit one plan step"},
	{Command: "/plan remove <step>", Description: "remove one plan step"},
	{Command: "/plan status <step> <pending|in_progress|completed|blocked>", Description: "manually set one plan step status"},
	{Command: "/plan run [step]", Description: "execute the next or selected plan step"},
	{Command: "/plan done <step>", Description: "mark one plan step completed"},
	{Command: "/plan accept [notes]", Description: "accept the current execution plan"},
	{Command: "/plan reopen", Description: "reopen an accepted plan for more work"},
	{Command: "/plan clear", Description: "clear the active execution plan"},
	{Command: "/sessions", Description: "open sessions panel"},
	{Command: "/resume", Description: "Resume a previous conversation"},
	{Command: "/resume <id>", Description: "resume a session by id"},
	{Command: "/load <id>", Description: "alias for /resume <id>"},
	{Command: "/new", Description: "start a fresh session"},
	{Command: "/cancel", Description: "cancel the current running turn"},
	{Command: "/undo", Description: "undo last approved filesystem mutation"},
	{Command: "/search-session <query>", Description: "search sessions by id/title/content"},
	{Command: "/search-session #<tag> [query]", Description: "search sessions by tag + query"},
	{Command: "/tag list", Description: "list tags of current session"},
	{Command: "/tag add <tag>", Description: "add tag to current session"},
	{Command: "/tag remove <tag>", Description: "remove tag from current session"},
	{Command: "/pin <note>", Description: "pin important context"},
	{Command: "/pins", Description: "list pinned context"},
	{Command: "/unpin <index>", Description: "remove a pin"},
	{Command: "/skills", Description: "show skills runtime summary"},
	{Command: "/skills list", Description: "list available skills"},
	{Command: "/skills create <task>", Description: "ask AI to generate and save a new project skill"},
	{Command: "/skills show <id>", Description: "show one skill details"},
	{Command: "/skills enable <id>", Description: "enable one skill in global skills config"},
	{Command: "/skills disable <id>", Description: "disable one skill in global skills config"},
	{Command: "/skills remove <id>", Description: "remove one skill via global remove_skills override"},
	{Command: "/skills use <id>", Description: "use one skill for the current session only"},
	{Command: "/skills reload", Description: "reload skills config"},
	{Command: "/extensions", Description: "show extensions runtime summary"},
	{Command: "/extensions list", Description: "list managed skills and MCP servers"},
	{Command: "/extensions skills", Description: "list managed skills with scope/exposure"},
	{Command: "/extensions mcp", Description: "list managed MCP servers with trust/scope/exposure"},
	{Command: "/extensions show <id|skill:<id>|mcp:<id>>", Description: "inspect one managed skill or MCP server"},
	{Command: "/extensions resolve <query>", Description: "preview which extensions would be selected for a query"},
	{Command: "/extensions enable <id|skill:<id>|mcp:<id>>", Description: "enable one managed skill or MCP server"},
	{Command: "/extensions disable <id|skill:<id>|mcp:<id>>", Description: "disable one managed skill or MCP server"},
	{Command: "/extensions exposure <hidden|hinted|scoped|full> <id|skill:<id>|mcp:<id>>", Description: "set exposure policy for one managed skill or MCP server"},
	{Command: "/mcp", Description: "show MCP runtime summary"},
	{Command: "/mcp servers", Description: "list registered MCP servers"},
	{Command: "/mcp server <id>", Description: "inspect one MCP server"},
	{Command: "/mcp tools", Description: "list tools across registered MCP servers"},
	{Command: "/mcp tools <server>", Description: "list tools for one MCP server"},
	{Command: "/mcp add stdio <id> <command...>", Description: "add a stdio MCP server to project config"},
	{Command: "/mcp add http <id> <url>", Description: "add an HTTP MCP server to project config"},
	{Command: "/mcp add filesystem <id> [workspace]", Description: "add a filesystem MCP server to project config"},
	{Command: "/mcp lsp list [filesystem-server]", Description: "list configured LSP servers for filesystem MCP servers"},
	{Command: "/mcp lsp add <filesystem-server> <preset>|<lsp-id> ...", Description: "add one mainstream-language LSP preset or a custom LSP server config"},
	{Command: "/mcp lsp remove <filesystem-server> <lsp-id>", Description: "remove one LSP server config from a filesystem MCP server"},
	{Command: "/mcp lsp doctor <filesystem-server> <path> [--lsp <lsp-id>]", Description: "inspect LSP matching and startup for one file path"},
	{Command: "/mcp lsp bootstrap <filesystem-server>", Description: "auto-add mainstream-language LSP presets detected in the workspace"},
	{Command: "/mcp pending", Description: "show pending MCP operations"},
	{Command: "/mcp reload", Description: "reload MCP config from disk"},
	{Command: "/mcp remove <id>", Description: "remove one MCP server"},
	{Command: "/mcp enable <id>", Description: "enable one MCP server"},
	{Command: "/mcp disable <id>", Description: "disable one MCP server"},
	{Command: "/review", Description: "open approval queue"},
	{Command: "/review <id>", Description: "inspect one pending operation"},
	{Command: "/approve [id]", Description: "approve pending operation(s)"},
	{Command: "/approve low", Description: "approve all non-high-risk operations"},
	{Command: "/approve all", Description: "approve all pending operations"},
	{Command: "/reject [id]", Description: "reject pending operation(s)"},
	{Command: "/reject all", Description: "reject all pending operations"},
	{Command: "/clear", Description: "Start a new session with empty context; previous session stays on disk (resumable with /resume)"},
	{Command: "/quit", Description: "quit bubble tea frontend"},
}

var slashPinnedDisplayCommands = []string{"/resume", "/clear"}

var readClipboardText = defaultClipboardTextReader

func init() {
	for index := range slashCommandCatalog {
		slashCommandCatalog[index].InsertValue = slashInsertValue(slashCommandCatalog[index].Command)
	}
}

type Message struct {
	Role string `json:"role"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

type ExecutionPlanStep struct {
	ID               string
	Title            string
	Details          string
	Status           string
	Evidence         []string
	FilePaths        []string
	RecentToolResult string
}

type ExecutionPlan struct {
	CapturedAt      string
	SourcePreview   string
	ProjectRoot     string
	Summary         string
	Objective       string
	AcceptedAt      string
	AcceptedSummary string
	Steps           []ExecutionPlanStep
}

type transcriptMessageCacheEntry struct {
	width   int
	message Message
	lines   []string
}

type Model struct {
	Width                      int
	Height                     int
	Status                     Status
	Items                      []Message
	LiveText                   string
	Input                      []rune
	Cursor                     int
	Composer                   textarea.Model
	Composition                []rune
	CompositionCursor          int
	SlashSelection             int
	TranscriptOffset           int
	ShouldQuit                 bool
	BridgeReady                bool
	Notice                     string
	NoticeIsError              bool
	MouseCapture               bool
	SpinnerFrame               int
	spinnerTickPending         bool
	QuitWithSummary            bool
	transcriptCacheWidth       int
	transcriptCacheVersion     int
	transcriptCacheLines       []string
	transcriptStaticCacheWidth int
	transcriptStaticCacheLines []string
	transcriptLiveCacheWidth   int
	transcriptLiveCacheText    string
	transcriptLiveCacheLines   []string
	transcriptMessageCache     []transcriptMessageCacheEntry
	transcriptVersion          int
	composerInitialized        bool
	composerMirrorValue        string
	composerMirrorCursor       int
	terminalCursorAnchorMu     sync.RWMutex
	terminalCursorAnchor       TerminalCursorAnchor

	ActivePanel Panel

	ApprovalIndex         int
	ApprovalPreview       ApprovalPreviewMode
	ApprovalPreviewOffset int
	PlanIndex             int
	SessionIndex          int
	ModelIndex            int
	ProviderIndex         int

	ActiveSessionID          string
	ExecutionPlan            ExecutionPlan
	Sessions                 []BridgeSession
	PendingReviews           []BridgeReview
	AvailableModels          []string
	AvailableProviders       []string
	ProviderProfiles         map[string]string
	ProviderFormats          map[string]string
	ProviderEndpoints        map[string]map[string]string
	ProviderProfileSources   map[string]string
	ProviderNames            map[string]string
	ManagedSkills            []BridgeManagedSkill
	ManagedMcpServers        []BridgeManagedMcpServer
	UsageSummary             BridgeUsageSummary
	CurrentModel             string
	CurrentProvider          string
	CurrentProviderFormat    string
	CurrentProviderKeySource string
	Auth                     BridgeAuthStatus
	AppRoot                  string

	AuthStep          AuthStep
	AuthProvider      []rune
	AuthProviderType  []rune
	AuthAPIKey        []rune
	AuthModel         []rune
	AuthCursor        int
	AuthSaving        bool
	LastClickAt       time.Time
	LastClickIdx      int
	LastClickPan      Panel
	LastMousePressAt  time.Time
	LastMousePressX   int
	LastMousePressY   int
	LastMousePressBtn tea.MouseButton
	LastMousePressReg mouseRegion
	LastMousePressIdx int
	LastMouseActAt    time.Time
	LastMouseActReg   mouseRegion
	LastMouseActIdx   int
	IgnorePasteUntil  time.Time

	ScrollbarDragActive     bool
	ScrollbarDragRegion     mouseRegion
	ScrollbarDragGrabOffset int

	bridge *bridgeClient
}

func NewModel() *Model {
	model := &Model{
		Width:                  100,
		Height:                 30,
		Status:                 StatusPreparing,
		SlashSelection:         -1,
		ActivePanel:            PanelNone,
		ApprovalPreview:        ApprovalFull,
		AuthStep:               AuthStepProvider,
		MouseCapture:           true,
		ProviderProfiles:       map[string]string{},
		ProviderFormats:        map[string]string{},
		ProviderEndpoints:      map[string]map[string]string{},
		ProviderProfileSources: map[string]string{},
		ProviderNames:          map[string]string{},
		Items: []Message{{
			Role: "system",
			Kind: "system_hint",
			Text: "Starting Bubble Tea v2 bridge...",
		}},
	}
	model.ensureComposerTextarea()
	return model
}

func newComposerTextarea() textarea.Model {
	input := textarea.New()
	input.Prompt = "❯ "
	input.Placeholder = "Ask Cyrene, use / commands, or mention files with @..."
	input.ShowLineNumbers = false
	input.EndOfBufferCharacter = ' '
	input.MaxHeight = 6
	input.SetPromptFunc(2, func(lineIndex int) string {
		if lineIndex == 0 {
			return "❯ "
		}
		return "  "
	})
	input.SetHeight(1)
	input.SetWidth(40)
	_ = input.Cursor.SetMode(cursor.CursorHide)
	_ = input.Focus()
	return input
}

func (m *Model) ensureComposerTextarea() {
	if m.composerInitialized {
		return
	}
	m.Composer = newComposerTextarea()
	m.composerInitialized = true
	m.composerMirrorValue = "\x00"
	m.composerMirrorCursor = -1
}

func composerTextareaStyle(promptStyle lipgloss.Style) textarea.Style {
	return textarea.Style{
		Base:             lipgloss.NewStyle(),
		CursorLine:       lipgloss.NewStyle(),
		CursorLineNumber: lipgloss.NewStyle(),
		EndOfBuffer:      lipgloss.NewStyle(),
		LineNumber:       lipgloss.NewStyle(),
		Placeholder:      toolStatusStyle,
		Prompt:           promptStyle,
		Text:             lipgloss.NewStyle(),
	}
}

func (m *Model) configureComposerTextarea(width, height int, promptStyle lipgloss.Style, placeholder string) {
	m.ensureComposerTextarea()
	style := composerTextareaStyle(promptStyle)
	m.Composer.FocusedStyle = style
	m.Composer.BlurredStyle = style
	m.Composer.Placeholder = placeholder
	m.Composer.ShowLineNumbers = false
	m.Composer.EndOfBufferCharacter = ' '
	m.Composer.SetPromptFunc(2, func(lineIndex int) string {
		if lineIndex == 0 {
			return "❯ "
		}
		return "  "
	})
	m.Composer.SetHeight(clampInt(height, 1, 6))
	m.Composer.SetWidth(maxInt(1, width))
	if len(m.Input) == 0 {
		_ = m.Composer.Cursor.SetMode(cursor.CursorHide)
	} else {
		_ = m.Composer.Cursor.SetMode(cursor.CursorStatic)
	}
	_ = m.Composer.Focus()
}

func (m *Model) syncComposerTextareaValue() {
	m.ensureComposerTextarea()
	value := string(m.Input)
	cursorPosition := clampInt(m.Cursor, 0, len(m.Input))
	if m.composerMirrorValue == value && m.composerMirrorCursor == cursorPosition {
		return
	}

	m.Composer.SetValue(value)
	if cursorPosition < len(m.Input) {
		m.Composer, _ = m.Composer.Update(tea.KeyMsg{Type: tea.KeyCtrlHome})
		for range cursorPosition {
			m.Composer, _ = m.Composer.Update(tea.KeyMsg{Type: tea.KeyRight})
		}
	}
	m.composerMirrorValue = value
	m.composerMirrorCursor = cursorPosition
}

func (m *Model) TerminalCursorAnchor() TerminalCursorAnchor {
	m.terminalCursorAnchorMu.RLock()
	defer m.terminalCursorAnchorMu.RUnlock()
	return m.terminalCursorAnchor
}

func (m *Model) setTerminalCursorAnchor(anchor TerminalCursorAnchor) {
	m.terminalCursorAnchorMu.Lock()
	defer m.terminalCursorAnchorMu.Unlock()
	m.terminalCursorAnchor = anchor
}

func (m *Model) Init() tea.Cmd {
	cmds := []tea.Cmd{startBridgeCmd()}
	if m.MouseCapture {
		cmds = append(cmds, tea.EnableMouseCellMotion)
	}
	return m.withStatusSpinner(tea.Batch(cmds...))
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch value := msg.(type) {
	case bridgeStartedMsg:
		m.bridge = value.Client
		m.BridgeReady = false
		m.Status = StatusPreparing
		m.setNotice("Bubble Tea bridge started.", false)
		return m, m.withStatusSpinner(tea.Batch(
			waitForBridgeEvent(m.bridge),
			sendBridgeCommand(m.bridge, bridgeCommand{Type: "init"}),
		))
	case statusSpinnerTickMsg:
		m.spinnerTickPending = false
		if !m.isAnimatingStatus() {
			m.SpinnerFrame = 0
			return m, nil
		}
		m.SpinnerFrame = (m.SpinnerFrame + 1) % len(statusSpinnerFrames)
		return m, m.withStatusSpinner(nil)
	case ComposerCompositionMsg:
		m.setComposerComposition(value.Text, value.Cursor)
		return m, nil
	case ComposerCompositionCommitMsg:
		m.commitComposerComposition(value.Text)
		return m, nil
	case ComposerCompositionClearMsg:
		m.clearComposerComposition()
		return m, nil
	case bridgeEventMsg:
		m.handleBridgeEvent(value.Event)
		if appRoot := value.Event.appRoot(); appRoot != "" {
			if err := syncProcessAppRoot(appRoot); err != nil {
				m.Status = StatusError
				m.setNotice(fmt.Sprintf("Failed to switch workspace: %v", err), true)
				return m, m.withStatusSpinner(nil)
			}
		}
		return m, m.withStatusSpinner(waitForBridgeEvent(m.bridge))
	case bridgeErrorMsg:
		m.Status = StatusError
		m.AuthSaving = false
		m.setNotice(value.Message, true)
		return m, m.withStatusSpinner(nil)
	case bridgeExitedMsg:
		m.BridgeReady = false
		m.bridge = nil
		m.AuthSaving = false
		if value.Err != nil {
			m.Status = StatusError
			m.setNotice(value.Err.Error(), true)
		} else if !m.ShouldQuit {
			m.setNotice("Bridge exited.", true)
		}
		return m, m.withStatusSpinner(nil)
	case tea.WindowSizeMsg:
		m.Width = value.Width
		m.Height = value.Height
		m.invalidateTranscriptCache()
		m.clampTranscriptOffset()
		return m, m.withStatusSpinner(nil)
	case tea.MouseMsg:
		hit := m.mouseHitAt(value.X, value.Y)
		if value.Action == tea.MouseActionPress && value.Button != tea.MouseButtonWheelUp && value.Button != tea.MouseButtonWheelDown && value.Button != tea.MouseButtonWheelLeft && value.Button != tea.MouseButtonWheelRight {
			m.rememberMousePress(value, hit)
		}
		if m.handleScrollbarMouse(value, hit) {
			return m, m.withStatusSpinner(nil)
		}
		switch value.Button {
		case tea.MouseButtonWheelUp:
			if value.Action != tea.MouseActionPress {
				return m, m.withStatusSpinner(nil)
			}
			m.handleWheelScroll(-1, hit)
		case tea.MouseButtonWheelDown:
			if value.Action != tea.MouseActionPress {
				return m, m.withStatusSpinner(nil)
			}
			m.handleWheelScroll(1, hit)
		case tea.MouseButtonLeft:
			if !m.shouldHandleMouseLeft(value, hit) {
				return m, m.withStatusSpinner(nil)
			}
			nextModel, cmd := m.handleMouseLeftClick(hit)
			if typed, ok := nextModel.(*Model); ok {
				return typed, typed.withStatusSpinner(cmd)
			}
			return nextModel, cmd
		case tea.MouseButtonRight:
			if value.Action != tea.MouseActionPress {
				return m, m.withStatusSpinner(nil)
			}
			if m.MouseCapture {
				m.IgnorePasteUntil = time.Now().Add(rightClickPasteWindow)
				m.setNotice("Right-click paste is blocked in mouse mode. Press F6 for terminal paste.", false)
			}
		default:
			if value.Action == tea.MouseActionRelease && m.shouldHandleMouseLeft(value, hit) {
				nextModel, cmd := m.handleMouseLeftClick(hit)
				if typed, ok := nextModel.(*Model); ok {
					return typed, typed.withStatusSpinner(cmd)
				}
				return nextModel, cmd
			}
		}
		return m, m.withStatusSpinner(nil)
	case tea.KeyMsg:
		if msg := value; msg.Type == tea.KeyRunes && m.shouldSuppressPaste(msg.Runes) {
			return m, m.withStatusSpinner(nil)
		}
		nextModel, cmd := m.handleKey(value)
		if typed, ok := nextModel.(*Model); ok {
			return typed, typed.withStatusSpinner(cmd)
		}
		return nextModel, cmd
	}

	return m, m.withStatusSpinner(nil)
}

func (m *Model) handleBridgeEvent(event bridgeEvent) {
	switch event.Type {
	case "init":
		m.applyBridgeSnapshot(event.Snapshot)
	case "set_status":
		m.BridgeReady = true
		m.Status = parseStatus(event.Status)
	case "set_live_text":
		m.BridgeReady = true
		if m.LiveText != event.LiveText {
			m.LiveText = event.LiveText
			m.invalidateTranscriptRenderCache()
			m.clampTranscriptOffset()
		}
	case "append_items":
		m.BridgeReady = true
		if len(event.Items) == 0 {
			return
		}
		if isDefaultEmptyState(m.Items) {
			m.Items = cloneMessages(event.Items)
			m.resetTranscriptMessageCache()
		} else {
			m.Items = append(m.Items, event.Items...)
			m.extendTranscriptMessageCache(len(event.Items))
		}
		m.invalidateTranscriptCache()
		m.clampTranscriptOffset()
	case "replace_items":
		m.BridgeReady = true
		m.Items = cloneMessages(event.Items)
		if len(m.Items) == 0 {
			m.Items = []Message{}
		}
		m.resetTranscriptMessageCache()
		m.invalidateTranscriptCache()
		m.clampTranscriptOffset()
	case "set_sessions":
		m.BridgeReady = true
		m.Sessions = cloneSessions(event.Sessions)
		m.ActiveSessionID = event.ActiveSessionID
		m.SessionIndex = clampInt(findSelectionIndex(m.Sessions, m.ActiveSessionID, m.SessionIndex), 0, maxInt(0, len(m.Sessions)-1))
	case "set_pending_reviews":
		m.BridgeReady = true
		m.PendingReviews = cloneReviews(event.PendingReviews)
		m.normalizePendingReviewsState()
	case "set_execution_plan":
		m.BridgeReady = true
		m.ExecutionPlan = cloneExecutionPlan(event.ExecutionPlan)
		m.normalizeExecutionPlanState()
	case "set_runtime_metadata":
		m.BridgeReady = true
		m.applyRuntimeMetadata(event)
	case "set_usage_summary":
		m.BridgeReady = true
		m.UsageSummary = event.UsageSummary
	case "set_auth_defaults":
		m.BridgeReady = true
		m.AuthProvider = []rune(strings.TrimSpace(event.ProviderBaseURL))
		m.AuthProviderType = []rune(strings.TrimSpace(event.ProviderType))
		m.AuthModel = []rune(strings.TrimSpace(event.Model))
		m.AuthAPIKey = []rune(event.APIKey)
		if m.ActivePanel == PanelAuth && m.AuthStep == AuthStepProvider {
			switch {
			case len(m.AuthProvider) > 0 && len(m.AuthProviderType) == 0:
				m.AuthStep = AuthStepProviderType
			case len(m.AuthProvider) > 0 && len(m.AuthProviderType) > 0 && len(m.AuthAPIKey) == 0:
				m.AuthStep = AuthStepAPIKey
			case len(m.AuthProvider) > 0 && len(m.AuthProviderType) > 0 && len(m.AuthAPIKey) > 0 && len(m.AuthModel) > 0:
				m.AuthStep = AuthStepConfirm
			case len(m.AuthProvider) > 0 && len(m.AuthProviderType) > 0 && len(m.AuthModel) > 0:
				m.AuthStep = AuthStepAPIKey
			}
		}
		switch m.AuthStep {
		case AuthStepProvider:
			m.AuthCursor = len(m.AuthProvider)
		case AuthStepProviderType:
			m.AuthCursor = len(m.AuthProviderType)
		case AuthStepAPIKey:
			m.AuthCursor = len(m.AuthAPIKey)
		case AuthStepModel:
			m.AuthCursor = len(m.AuthModel)
		default:
			m.AuthCursor = 0
		}
	case "error":
		m.Status = StatusError
		m.AuthSaving = false
		m.setNotice(event.Message, true)
	}
}

func (m *Model) isAnimatingStatus() bool {
	switch m.Status {
	case StatusPreparing, StatusRequesting, StatusStreaming, StatusAwaitingReview:
		return true
	default:
		return false
	}
}

func statusSpinnerTickCmd() tea.Cmd {
	return tea.Tick(statusSpinnerInterval, func(time.Time) tea.Msg {
		return statusSpinnerTickMsg{}
	})
}

func (m *Model) withStatusSpinner(cmd tea.Cmd) tea.Cmd {
	if !m.isAnimatingStatus() {
		m.spinnerTickPending = false
		m.SpinnerFrame = 0
		return cmd
	}
	if m.spinnerTickPending {
		return cmd
	}
	m.spinnerTickPending = true
	if cmd == nil {
		return statusSpinnerTickCmd()
	}
	return tea.Batch(cmd, statusSpinnerTickCmd())
}

func (m *Model) applyBridgeSnapshot(snapshot *bridgeSnapshot) {
	if snapshot == nil {
		return
	}

	m.BridgeReady = true
	m.Items = cloneMessages(snapshot.Items)
	m.LiveText = snapshot.LiveText
	m.ExecutionPlan = cloneExecutionPlan(snapshot.ExecutionPlan)
	m.resetTranscriptMessageCache()
	m.PendingReviews = cloneReviews(snapshot.PendingReviews)
	m.Sessions = cloneSessions(snapshot.Sessions)
	m.ActiveSessionID = snapshot.ActiveSessionID
	m.Status = parseStatus(snapshot.Status)
	m.AvailableModels = cloneStrings(snapshot.AvailableModels)
	m.AvailableProviders = cloneStrings(snapshot.AvailableProviders)
	m.ProviderProfiles = cloneStringMap(snapshot.ProviderProfiles)
	m.ProviderFormats = cloneStringMap(snapshot.ProviderFormats)
	m.ProviderEndpoints = cloneNestedStringMap(snapshot.ProviderEndpoints)
	m.ProviderProfileSources = cloneStringMap(snapshot.ProviderProfileSources)
	m.ProviderNames = cloneStringMap(snapshot.ProviderNames)
	m.ManagedSkills = cloneManagedSkills(snapshot.ManagedSkills)
	m.ManagedMcpServers = cloneManagedMcpServers(snapshot.ManagedMcpServers)
	m.UsageSummary = snapshot.UsageSummary
	m.CurrentModel = snapshot.CurrentModel
	m.CurrentProvider = snapshot.CurrentProvider
	m.CurrentProviderFormat = snapshot.CurrentProviderFormat
	m.CurrentProviderKeySource = snapshot.CurrentProviderKeySource
	m.Auth = snapshot.Auth
	m.AppRoot = snapshot.AppRoot
	m.invalidateTranscriptCache()
	m.normalizeBridgeSelections()
	m.handleAuthRefreshSideEffects()
	if m.Notice != "" && !m.NoticeIsError {
		m.Notice = ""
	}
}

func (m *Model) applyRuntimeMetadata(event bridgeEvent) {
	m.AvailableModels = cloneStrings(event.AvailableModels)
	m.AvailableProviders = cloneStrings(event.AvailableProviders)
	m.ProviderProfiles = cloneStringMap(event.ProviderProfiles)
	m.ProviderFormats = cloneStringMap(event.ProviderFormats)
	m.ProviderEndpoints = cloneNestedStringMap(event.ProviderEndpoints)
	m.ProviderProfileSources = cloneStringMap(event.ProviderProfileSources)
	m.ProviderNames = cloneStringMap(event.ProviderNames)
	m.ManagedSkills = cloneManagedSkills(event.ManagedSkills)
	m.ManagedMcpServers = cloneManagedMcpServers(event.ManagedMcpServers)
	m.CurrentModel = event.CurrentModel
	m.CurrentProvider = event.CurrentProvider
	m.CurrentProviderFormat = event.CurrentProviderFormat
	m.CurrentProviderKeySource = event.CurrentProviderKeySource
	m.Auth = event.Auth
	if strings.TrimSpace(event.AppRoot) != "" {
		m.AppRoot = event.AppRoot
	}
	m.normalizeRuntimeMetadataState()
	m.handleAuthRefreshSideEffects()
}

func (m *Model) normalizeBridgeSelections() {
	m.normalizePendingReviewsState()
	m.normalizeExecutionPlanState()
	m.normalizeRuntimeMetadataState()
	m.SessionIndex = clampInt(findSelectionIndex(m.Sessions, m.ActiveSessionID, m.SessionIndex), 0, maxInt(0, len(m.Sessions)-1))
	m.clampTranscriptOffset()
}

func (m *Model) normalizePendingReviewsState() {
	m.ApprovalIndex = clampInt(m.ApprovalIndex, 0, maxInt(0, len(m.PendingReviews)-1))
	m.ApprovalPreviewOffset = clampInt(m.ApprovalPreviewOffset, 0, maxInt(0, m.currentApprovalPreviewLineCount()-approvalPreviewPageLines))
	if len(m.PendingReviews) == 0 && m.ActivePanel == PanelApprovals {
		m.ActivePanel = PanelNone
	}
}

func (m *Model) normalizeExecutionPlanState() {
	m.PlanIndex = clampInt(m.PlanIndex, 0, maxInt(0, len(m.ExecutionPlan.Steps)-1))
}

func (m *Model) normalizeRuntimeMetadataState() {
	if m.ProviderProfiles == nil {
		m.ProviderProfiles = map[string]string{}
	}
	if m.ProviderFormats == nil {
		m.ProviderFormats = map[string]string{}
	}
	if m.ProviderEndpoints == nil {
		m.ProviderEndpoints = map[string]map[string]string{}
	}
	if m.ProviderProfileSources == nil {
		m.ProviderProfileSources = map[string]string{}
	}
	if m.ProviderNames == nil {
		m.ProviderNames = map[string]string{}
	}
	m.ModelIndex = clampInt(findStringIndex(m.AvailableModels, m.CurrentModel, m.ModelIndex), 0, maxInt(0, len(m.AvailableModels)-1))
	m.ProviderIndex = clampInt(findStringIndex(m.AvailableProviders, m.CurrentProvider, m.ProviderIndex), 0, maxInt(0, len(m.AvailableProviders)-1))
}

func (m *Model) handleAuthRefreshSideEffects() {
	if !m.AuthSaving {
		return
	}
	m.AuthSaving = false
	if m.Auth.HTTPReady {
		m.ActivePanel = PanelNone
		m.setNotice("HTTP login updated.", false)
	}
}

func parseStatus(raw string) Status {
	switch Status(raw) {
	case StatusPreparing, StatusRequesting, StatusStreaming, StatusAwaitingReview, StatusError:
		return Status(raw)
	default:
		return StatusIdle
	}
}

func syncProcessAppRoot(appRoot string) error {
	trimmed := strings.TrimSpace(appRoot)
	if trimmed == "" {
		return nil
	}
	if err := os.Chdir(trimmed); err != nil {
		return err
	}
	if err := os.Setenv("CYRENE_ROOT", trimmed); err != nil {
		return err
	}
	return nil
}

func (m *Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyCtrlC:
		m.ShouldQuit = true
		m.QuitWithSummary = true
		if m.bridge != nil {
			m.bridge.Close()
		}
		return m, tea.Quit
	case tea.KeyPgUp:
		m.TranscriptOffset += scrollStep
		m.clampTranscriptOffset()
		return m, nil
	case tea.KeyPgDown:
		m.TranscriptOffset -= scrollStep
		if m.TranscriptOffset < 0 {
			m.TranscriptOffset = 0
		}
		m.clampTranscriptOffset()
		return m, nil
	case tea.KeyF6:
		m.MouseCapture = !m.MouseCapture
		m.IgnorePasteUntil = time.Time{}
		if m.MouseCapture {
			m.setNotice("Mouse capture enabled. Wheel targets the hovered pane and picker clicks are active again.", false)
			return m, tea.EnableMouseCellMotion
		}
		m.setNotice("Copy mode enabled. Drag to select text; terminal paste is active here. Press F6 to restore in-app mouse scrolling.", false)
		return m, tea.DisableMouse
	case tea.KeyCtrlV:
		return m.handleClipboardPaste()
	}

	if m.ActivePanel != PanelNone {
		return m.handlePanelKey(msg)
	}
	return m.handleComposerKey(msg)
}

func (m *Model) handleClipboardPaste() (tea.Model, tea.Cmd) {
	text, err := readClipboardText()
	if err != nil {
		m.setNotice(fmt.Sprintf("Clipboard paste failed: %v. Press F6 for terminal paste.", err), true)
		return m, nil
	}
	if text == "" {
		return m, nil
	}

	switch m.ActivePanel {
	case PanelNone:
		m.insertRunes([]rune(text))
	case PanelAuth:
		m.insertAuthRunes(filterAuthInputRunes([]rune(text)))
	default:
		m.setNotice("Clipboard paste is only available in text input fields.", false)
	}
	return m, nil
}

func (m *Model) handleComposerKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEnter:
		if m.applySelectedSlashCompletion() {
			return m, nil
		}
		return m, m.submitInput()
	case tea.KeyHome:
		m.Cursor = 0
		return m, nil
	case tea.KeyEnd:
		m.Cursor = len(m.Input)
		return m, nil
	case tea.KeyCtrlJ:
		m.insertRunes([]rune{'\n'})
		return m, nil
	case tea.KeyCtrlU:
		m.clearComposerInput()
		return m, nil
	case tea.KeyCtrlK:
		m.deleteComposerToEnd()
		return m, nil
	case tea.KeyCtrlW:
		m.deleteComposerWordBackward()
		return m, nil
	case tea.KeyBackspace:
		m.deleteBackward()
		return m, nil
	case tea.KeyDelete, tea.KeyCtrlD:
		m.deleteForward()
		return m, nil
	case tea.KeyLeft:
		if m.Cursor > 0 {
			m.Cursor--
		}
		return m, nil
	case tea.KeyRight:
		if m.Cursor < len(m.Input) {
			m.Cursor++
		}
		return m, nil
	case tea.KeyUp:
		if m.moveSlashSelection(-1) {
			return m, nil
		}
		m.TranscriptOffset++
		m.clampTranscriptOffset()
		return m, nil
	case tea.KeyDown:
		if m.moveSlashSelection(1) {
			return m, nil
		}
		if m.TranscriptOffset > 0 {
			m.TranscriptOffset--
		}
		m.clampTranscriptOffset()
		return m, nil
	case tea.KeyEscape:
		m.clearComposerInput()
		return m, nil
	case tea.KeySpace:
		m.insertRunes([]rune{' '})
		return m, nil
	case tea.KeyTab:
		m.applySlashCompletion()
		return m, nil
	case tea.KeyRunes:
		m.insertRunes(msg.Runes)
		return m, nil
	default:
		return m, nil
	}
}

func (m *Model) handleWheelScroll(direction int, hit mouseHit) {
	switch hit.Region {
	case mouseRegionTranscript, mouseRegionTranscriptScrollbar:
		if direction < 0 {
			m.TranscriptOffset += scrollStep
			m.clampTranscriptOffset()
			return
		}
		m.TranscriptOffset -= scrollStep
		if m.TranscriptOffset < 0 {
			m.TranscriptOffset = 0
		}
		m.clampTranscriptOffset()
	case mouseRegionApprovalQueue:
		if len(m.PendingReviews) > 0 {
			m.ApprovalIndex = cycleIndex(m.ApprovalIndex, len(m.PendingReviews), direction)
			m.ApprovalPreviewOffset = 0
		}
	case mouseRegionApprovalPreview, mouseRegionApprovalPreviewScrollbar:
		m.scrollApprovalPreview(direction * scrollStep)
	case mouseRegionPlanList, mouseRegionPlanListScrollbar:
		if len(m.ExecutionPlan.Steps) > 0 {
			m.PlanIndex = cycleIndex(m.PlanIndex, len(m.ExecutionPlan.Steps), direction)
		}
	case mouseRegionSessionList, mouseRegionSessionListScrollbar:
		if len(m.Sessions) > 0 {
			m.SessionIndex = cycleIndex(m.SessionIndex, len(m.Sessions), direction)
		}
	case mouseRegionModelList, mouseRegionModelListScrollbar:
		if len(m.AvailableModels) > 0 {
			m.ModelIndex = cycleIndex(m.ModelIndex, len(m.AvailableModels), direction)
		}
	case mouseRegionProviderList, mouseRegionProviderListScrollbar:
		if len(m.AvailableProviders) > 0 {
			m.ProviderIndex = cycleIndex(m.ProviderIndex, len(m.AvailableProviders), direction)
		}
	}
}

func (m *Model) clampTranscriptOffset() {
	contentWidth, transcriptHeight := m.transcriptViewportMetrics()
	total := len(m.renderTranscriptLines(contentWidth))
	maxOffset := maxInt(0, total-transcriptHeight)
	m.TranscriptOffset = clampInt(m.TranscriptOffset, 0, maxOffset)
}

func (m *Model) transcriptViewportMetrics() (int, int) {
	width := maxInt(50, m.Width)
	height := maxInt(18, m.Height)
	contentWidth := maxInt(30, framedInnerWidth(appShellStyle, width))
	contentHeight := maxInt(12, framedInnerHeight(appShellStyle, height))
	header := m.renderTopStatusBar(contentWidth)
	composer := m.renderComposer(contentWidth)
	footer := m.renderBottomStatusBar(contentWidth)
	fixedHeight := lipgloss.Height(header) + lipgloss.Height(composer) + lipgloss.Height(footer) + 2
	bodyHeight := maxInt(5, contentHeight-fixedHeight)
	contentAreaHeight := maxInt(1, bodyHeight)

	if m.ActivePanel == PanelNone {
		return maxInt(1, framedInnerWidth(activeFrameStyle, contentWidth)-2), maxInt(1, framedInnerHeight(activeFrameStyle, contentAreaHeight))
	}

	if contentWidth >= 96 {
		panelWidth := m.widePanelWidth(contentWidth)
		sessionWidth := maxInt(24, contentWidth-panelWidth-1)
		return maxInt(1, framedInnerWidth(activeFrameStyle, sessionWidth)-2), maxInt(1, framedInnerHeight(activeFrameStyle, contentAreaHeight))
	}

	panelHeight := clampInt(contentAreaHeight/2, 10, 16)
	sessionHeight := maxInt(4, contentAreaHeight-panelHeight-1)
	return maxInt(1, framedInnerWidth(activeFrameStyle, contentWidth)-2), maxInt(1, framedInnerHeight(activeFrameStyle, sessionHeight))
}

func (m *Model) handleMouseLeftClick(hit mouseHit) (tea.Model, tea.Cmd) {
	if m.ActivePanel == PanelNone {
		return m, nil
	}

	index := hit.Index
	if index < 0 {
		return m, nil
	}

	now := time.Now()
	doubleClick := m.LastClickPan == m.ActivePanel &&
		m.LastClickIdx == index &&
		!m.LastClickAt.IsZero() &&
		now.Sub(m.LastClickAt) <= mouseDoubleClickWindow

	m.LastClickPan = m.ActivePanel
	m.LastClickIdx = index
	m.LastClickAt = now

	switch hit.Region {
	case mouseRegionApprovalQueue:
		m.ApprovalIndex = index
		m.ApprovalPreviewOffset = 0
	case mouseRegionPlanList:
		m.PlanIndex = index
	case mouseRegionSessionList:
		m.SessionIndex = index
		if doubleClick && index >= 0 && index < len(m.Sessions) {
			m.Status = StatusPreparing
			m.setNotice("Loading selected session...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "load_session", ID: m.Sessions[index].ID})
		}
	case mouseRegionModelList:
		m.ModelIndex = index
		if doubleClick && index >= 0 && index < len(m.AvailableModels) {
			m.Status = StatusPreparing
			m.setNotice("Switching model...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_model", Value: m.AvailableModels[index]})
		}
	case mouseRegionProviderList:
		m.ProviderIndex = index
		if doubleClick && index >= 0 && index < len(m.AvailableProviders) {
			m.Status = StatusPreparing
			m.setNotice("Switching provider...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_provider", Value: m.AvailableProviders[index]})
		}
	default:
		return m, nil
	}

	return m, nil
}

func (m *Model) rememberMousePress(msg tea.MouseMsg, hit mouseHit) {
	m.LastMousePressAt = time.Now()
	m.LastMousePressX = msg.X
	m.LastMousePressY = msg.Y
	m.LastMousePressBtn = msg.Button
	m.LastMousePressReg = hit.Region
	m.LastMousePressIdx = hit.Index
}

func (m *Model) shouldHandleMouseLeft(msg tea.MouseMsg, hit mouseHit) bool {
	now := time.Now()
	switch {
	case msg.Button == tea.MouseButtonLeft && msg.Action == tea.MouseActionPress:
		m.markMouseActivation(now, hit)
		return true
	case msg.Action == tea.MouseActionRelease:
		if m.LastMousePressBtn != tea.MouseButtonLeft || now.Sub(m.LastMousePressAt) > mouseReleaseWindow {
			return false
		}
		if hit.Region != m.LastMousePressReg || hit.Index != m.LastMousePressIdx {
			return false
		}
		if m.isDuplicateMouseActivation(now, hit) {
			return false
		}
		m.markMouseActivation(now, hit)
		return true
	default:
		return false
	}
}

func (m *Model) isDuplicateMouseActivation(now time.Time, hit mouseHit) bool {
	return hit.Region == m.LastMouseActReg &&
		hit.Index == m.LastMouseActIdx &&
		!m.LastMouseActAt.IsZero() &&
		now.Sub(m.LastMouseActAt) <= mouseActivationDedup
}

func (m *Model) markMouseActivation(now time.Time, hit mouseHit) {
	m.LastMouseActAt = now
	m.LastMouseActReg = hit.Region
	m.LastMouseActIdx = hit.Index
}

func (m *Model) handleScrollbarMouse(msg tea.MouseMsg, hit mouseHit) bool {
	if m.ScrollbarDragActive {
		switch msg.Action {
		case tea.MouseActionMotion:
			if !m.updateScrollbarDrag(msg.Y) {
				m.stopScrollbarDrag()
			}
			return true
		case tea.MouseActionRelease:
			m.stopScrollbarDrag()
			return true
		}
	}

	if msg.Button != tea.MouseButtonLeft || msg.Action != tea.MouseActionPress {
		return false
	}

	geometry, ok := m.scrollbarGeometryByRegion(hit.Region)
	if !ok {
		return false
	}

	m.startScrollbarDrag(geometry, msg.Y)
	return true
}

func (m *Model) startScrollbarDrag(geometry scrollbarGeometry, mouseY int) {
	trackLine := geometry.trackLineAt(mouseY)
	grabOffset := geometry.ThumbSize / 2
	if geometry.ThumbSize > 0 && trackLine >= geometry.ThumbStart && trackLine < geometry.ThumbStart+geometry.ThumbSize {
		grabOffset = trackLine - geometry.ThumbStart
	}

	m.ScrollbarDragActive = true
	m.ScrollbarDragRegion = geometry.Region
	m.ScrollbarDragGrabOffset = maxInt(0, grabOffset)
	m.dragScrollbarTo(geometry, mouseY)
}

func (m *Model) stopScrollbarDrag() {
	m.ScrollbarDragActive = false
	m.ScrollbarDragRegion = mouseRegionNone
	m.ScrollbarDragGrabOffset = 0
}

func (m *Model) updateScrollbarDrag(mouseY int) bool {
	geometry, ok := m.scrollbarGeometryByRegion(m.ScrollbarDragRegion)
	if !ok {
		return false
	}
	m.dragScrollbarTo(geometry, mouseY)
	return true
}

func (m *Model) dragScrollbarTo(geometry scrollbarGeometry, mouseY int) {
	maxStart := scrollbarMaxStart(geometry.Scroll, geometry.TrackHeight)
	if maxStart <= 0 {
		m.setScrollbarOffset(geometry.Region, geometry.Scroll, 0)
		return
	}

	trackLine := geometry.trackLineAt(mouseY)
	thumbStart := clampInt(trackLine-m.ScrollbarDragGrabOffset, 0, maxStart)
	m.setScrollbarOffset(geometry.Region, geometry.Scroll, scrollbarOffsetForThumbStart(geometry.Scroll, geometry.TrackHeight, thumbStart))
}

func scrollbarMaxStart(scroll panelScrollState, trackHeight int) int {
	if trackHeight <= 0 {
		return 0
	}
	_, thumbSize := scrollbarThumb(scroll, trackHeight)
	if thumbSize <= 0 {
		return 0
	}
	return maxInt(0, trackHeight-thumbSize)
}

func scrollbarOffsetForThumbStart(scroll panelScrollState, trackHeight, thumbStart int) int {
	visible := minInt(scroll.Visible, scroll.Total)
	maxOffset := maxInt(0, scroll.Total-visible)
	if trackHeight <= 0 || visible <= 0 || maxOffset <= 0 {
		return 0
	}

	maxStart := scrollbarMaxStart(scroll, trackHeight)
	if maxStart <= 0 {
		return 0
	}

	safeStart := clampInt(thumbStart, 0, maxStart)
	return (safeStart*maxOffset + (maxStart / 2)) / maxStart
}

func pageSelectionForOffset(currentIndex, total, pageSize, pageOffset int) int {
	if total <= 0 {
		return 0
	}

	safePageSize := maxInt(1, pageSize)
	safeIndex := clampInt(currentIndex, 0, total-1)
	rowOffset := safeIndex % safePageSize
	maxPage := (total - 1) / safePageSize
	targetPage := clampInt(pageOffset, 0, maxPage)
	return minInt(targetPage*safePageSize+rowOffset, total-1)
}

func (m *Model) setScrollbarOffset(region mouseRegion, scroll panelScrollState, offset int) {
	switch region {
	case mouseRegionTranscriptScrollbar:
		maxOffset := maxInt(0, scroll.Total-minInt(scroll.Visible, scroll.Total))
		m.TranscriptOffset = clampInt(maxOffset-offset, 0, maxOffset)
		m.clampTranscriptOffset()
	case mouseRegionApprovalPreviewScrollbar:
		m.ApprovalPreviewOffset = clampInt(offset, 0, maxInt(0, m.currentApprovalPreviewLineCount()-approvalPreviewPageLines))
	case mouseRegionPlanListScrollbar:
		m.PlanIndex = pageSelectionForOffset(m.PlanIndex, len(m.ExecutionPlan.Steps), m.planPanelPageSize(), offset)
	case mouseRegionSessionListScrollbar:
		m.SessionIndex = pageSelectionForOffset(m.SessionIndex, len(m.Sessions), m.sessionPanelPageSize(), offset)
	case mouseRegionModelListScrollbar:
		m.ModelIndex = pageSelectionForOffset(m.ModelIndex, len(m.AvailableModels), m.modelPanelPageSize(), offset)
	case mouseRegionProviderListScrollbar:
		m.ProviderIndex = pageSelectionForOffset(m.ProviderIndex, len(m.AvailableProviders), m.providerPanelPageSize(), offset)
	}
}

func (m *Model) activePanelRect() (int, int, int, int, bool) {
	layout := m.mouseLayout()
	if !layout.HasPanel {
		return 0, 0, 0, 0, false
	}
	return layout.Panel.Left, layout.Panel.Top, layout.Panel.Width, layout.Panel.Height, true
}

func (m *Model) panelHeight() int {
	_, _, _, panelHeight, ok := m.activePanelRect()
	if !ok {
		return 0
	}
	return panelHeight
}

func (m *Model) sessionPanelPageSize() int {
	_, _, panelWidth, panelHeight, ok := m.activePanelRect()
	if !ok {
		return 1
	}
	return m.sessionPanelPageSizeForDimensions(panelWidth, panelHeight)
}

func (m *Model) sessionPanelPageSizeForDimensions(width, height int) int {
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	return dynamicPanelPageSize(bodyHeight, 9, 2)
}

func (m *Model) modelPanelPageSize() int {
	_, _, panelWidth, panelHeight, ok := m.activePanelRect()
	if !ok {
		return 1
	}
	return m.modelPanelPageSizeForDimensions(panelWidth, panelHeight)
}

func (m *Model) modelPanelPageSizeForDimensions(width, height int) int {
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	return dynamicPanelPageSize(bodyHeight, 8, 2)
}

func (m *Model) providerPanelPageSize() int {
	_, _, panelWidth, panelHeight, ok := m.activePanelRect()
	if !ok {
		return 1
	}
	return m.providerPanelPageSizeForDimensions(panelWidth, panelHeight)
}

func (m *Model) providerPanelPageSizeForDimensions(width, height int) int {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	return dynamicPanelPageSize(bodyHeight, 10+providerPanelCommandRows(bodyWidth), 3)
}

func (m *Model) planPanelPageSize() int {
	_, _, panelWidth, panelHeight, ok := m.activePanelRect()
	if !ok {
		return 1
	}
	return m.planPanelPageSizeForDimensions(panelWidth, panelHeight)
}

func (m *Model) planPanelPageSizeForDimensions(width, height int) int {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	return dynamicPanelPageSize(bodyHeight, 12+planPanelOverviewRows(bodyWidth, m.ExecutionPlan), 2)
}

func planPanelOverviewRows(bodyWidth int, plan ExecutionPlan) int {
	rows := 0
	if strings.TrimSpace(plan.Summary) != "" {
		rows += len(wrapPlainText(plan.Summary, bodyWidth))
	}
	if strings.TrimSpace(plan.ProjectRoot) != "" {
		rows += len(wrapPlainText("project "+plan.ProjectRoot, bodyWidth))
	}
	if strings.TrimSpace(plan.Objective) != "" {
		rows += len(wrapPlainText("objective "+plan.Objective, bodyWidth))
	}
	return rows
}

func planPanelAcceptedRows(bodyWidth int, plan ExecutionPlan) int {
	if strings.TrimSpace(plan.AcceptedAt) == "" {
		return 0
	}
	acceptedLabel := "accepted " + plan.AcceptedAt
	if strings.TrimSpace(plan.AcceptedSummary) != "" {
		acceptedLabel += "  |  " + plan.AcceptedSummary
	}
	return len(wrapPlainText(acceptedLabel, bodyWidth))
}

func dynamicPanelPageSize(bodyHeight, reservedRows, rowsPerItem int) int {
	if rowsPerItem <= 0 {
		return 1
	}
	usableRows := bodyHeight - reservedRows - rowsPerItem
	if usableRows < rowsPerItem {
		return 1
	}
	return maxInt(1, usableRows/rowsPerItem)
}

func providerPanelCommandRows(bodyWidth int) int {
	return 0
}

func listIndexAtPanelLine(total, selected, pageSize, rowsPerItem, innerY, dataStartLine int) (int, bool) {
	if total <= 0 || innerY < dataStartLine {
		return 0, false
	}
	if rowsPerItem <= 0 {
		return 0, false
	}
	row := innerY - dataStartLine
	indexInPage := row / rowsPerItem
	page := pageForSelection(total, selected, pageSize)
	index := page.Start + indexInPage
	if index < page.Start || index >= page.End {
		return 0, false
	}
	return index, true
}

func (m *Model) handlePanelKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.Type == tea.KeyEscape {
		m.ActivePanel = PanelNone
		m.AuthSaving = false
		m.setNotice("", false)
		return m, nil
	}

	switch m.ActivePanel {
	case PanelApprovals:
		return m.handleApprovalKey(msg)
	case PanelPlans:
		return m.handlePlanKey(msg)
	case PanelSessions:
		return m.handleSessionKey(msg)
	case PanelModels:
		return m.handleModelKey(msg)
	case PanelProviders:
		return m.handleProviderKey(msg)
	case PanelAuth:
		return m.handleAuthKey(msg)
	default:
		m.ActivePanel = PanelNone
		return m, nil
	}
}

func (m *Model) handleApprovalKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyUp:
		if len(m.PendingReviews) > 0 {
			m.ApprovalIndex = cycleIndex(m.ApprovalIndex, len(m.PendingReviews), -1)
			m.ApprovalPreviewOffset = 0
		}
		return m, nil
	case tea.KeyDown:
		if len(m.PendingReviews) > 0 {
			m.ApprovalIndex = cycleIndex(m.ApprovalIndex, len(m.PendingReviews), 1)
			m.ApprovalPreviewOffset = 0
		}
		return m, nil
	case tea.KeyLeft:
		if len(m.PendingReviews) > 0 {
			m.ApprovalIndex = movePagedSelection(m.ApprovalIndex, len(m.PendingReviews), approvalQueuePageSize, "left")
			m.ApprovalPreviewOffset = 0
		}
		return m, nil
	case tea.KeyRight:
		if len(m.PendingReviews) > 0 {
			m.ApprovalIndex = movePagedSelection(m.ApprovalIndex, len(m.PendingReviews), approvalQueuePageSize, "right")
			m.ApprovalPreviewOffset = 0
		}
		return m, nil
	case tea.KeyTab:
		if m.ApprovalPreview == ApprovalSummary {
			m.ApprovalPreview = ApprovalFull
		} else {
			m.ApprovalPreview = ApprovalSummary
		}
		m.ApprovalPreviewOffset = 0
		return m, nil
	case tea.KeyPgDown:
		m.scrollApprovalPreview(approvalPreviewPageLines)
		return m, nil
	case tea.KeyPgUp:
		m.scrollApprovalPreview(-approvalPreviewPageLines)
		return m, nil
	case tea.KeyRunes:
		if len(msg.Runes) != 1 {
			return m, nil
		}
		if len(m.PendingReviews) == 0 {
			return m, nil
		}
		switch strings.ToLower(string(msg.Runes)) {
		case "a":
			m.Status = StatusPreparing
			m.setNotice("Approving selected review...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "approve", ID: m.PendingReviews[m.ApprovalIndex].ID})
		case "r", "d":
			m.Status = StatusPreparing
			m.setNotice("Rejecting selected review...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "reject", ID: m.PendingReviews[m.ApprovalIndex].ID})
		case "j":
			m.scrollApprovalPreview(approvalPreviewPageLines)
			return m, nil
		case "k":
			m.scrollApprovalPreview(-approvalPreviewPageLines)
			return m, nil
		}
	}
	return m, nil
}

func (m *Model) handlePlanKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyUp:
		if len(m.ExecutionPlan.Steps) > 0 {
			m.PlanIndex = cycleIndex(m.PlanIndex, len(m.ExecutionPlan.Steps), -1)
		}
		return m, nil
	case tea.KeyDown:
		if len(m.ExecutionPlan.Steps) > 0 {
			m.PlanIndex = cycleIndex(m.PlanIndex, len(m.ExecutionPlan.Steps), 1)
		}
		return m, nil
	case tea.KeyLeft:
		if len(m.ExecutionPlan.Steps) > 0 {
			m.PlanIndex = movePagedSelection(m.PlanIndex, len(m.ExecutionPlan.Steps), m.planPanelPageSize(), "left")
		}
		return m, nil
	case tea.KeyRight:
		if len(m.ExecutionPlan.Steps) > 0 {
			m.PlanIndex = movePagedSelection(m.PlanIndex, len(m.ExecutionPlan.Steps), m.planPanelPageSize(), "right")
		}
		return m, nil
	case tea.KeyEnter:
		if len(m.ExecutionPlan.Steps) == 0 {
			return m, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Running selected execution plan step...", false)
		return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: fmt.Sprintf("/plan run %d", m.PlanIndex+1)})
	case tea.KeyRunes:
		if len(msg.Runes) != 1 {
			return m, nil
		}
		switch strings.ToLower(string(msg.Runes)) {
		case "r":
			if len(m.ExecutionPlan.Steps) == 0 {
				return m, nil
			}
			m.Status = StatusPreparing
			m.setNotice("Running selected execution plan step...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: fmt.Sprintf("/plan run %d", m.PlanIndex+1)})
		case "d":
			if len(m.ExecutionPlan.Steps) == 0 {
				return m, nil
			}
			m.Status = StatusPreparing
			m.setNotice("Marking selected plan step completed...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: fmt.Sprintf("/plan done %d", m.PlanIndex+1)})
		case "c":
			m.Status = StatusPreparing
			m.setNotice("Clearing execution plan...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: "/plan clear"})
		case "a":
			m.Status = StatusPreparing
			m.setNotice("Accepting execution plan...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: "/plan accept"})
		}
	}
	return m, nil
}

func (m *Model) handleSessionKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyUp:
		if len(m.Sessions) > 0 {
			m.SessionIndex = cycleIndex(m.SessionIndex, len(m.Sessions), -1)
		}
		return m, nil
	case tea.KeyDown:
		if len(m.Sessions) > 0 {
			m.SessionIndex = cycleIndex(m.SessionIndex, len(m.Sessions), 1)
		}
		return m, nil
	case tea.KeyLeft:
		if len(m.Sessions) > 0 {
			m.SessionIndex = movePagedSelection(m.SessionIndex, len(m.Sessions), m.sessionPanelPageSize(), "left")
		}
		return m, nil
	case tea.KeyRight:
		if len(m.Sessions) > 0 {
			m.SessionIndex = movePagedSelection(m.SessionIndex, len(m.Sessions), m.sessionPanelPageSize(), "right")
		}
		return m, nil
	case tea.KeyEnter:
		if len(m.Sessions) == 0 {
			return m, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Loading selected session...", false)
		return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "load_session", ID: m.Sessions[m.SessionIndex].ID})
	case tea.KeyRunes:
		if len(msg.Runes) != 1 {
			return m, nil
		}
		switch strings.ToLower(string(msg.Runes)) {
		case "n":
			m.Status = StatusPreparing
			m.setNotice("Creating a new session...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "new_session"})
		case "r":
			m.setNotice("Refreshing sessions...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "list_sessions"})
		}
	}
	return m, nil
}

func (m *Model) handleModelKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyUp:
		if len(m.AvailableModels) > 0 {
			m.ModelIndex = cycleIndex(m.ModelIndex, len(m.AvailableModels), -1)
		}
		return m, nil
	case tea.KeyDown:
		if len(m.AvailableModels) > 0 {
			m.ModelIndex = cycleIndex(m.ModelIndex, len(m.AvailableModels), 1)
		}
		return m, nil
	case tea.KeyLeft:
		if len(m.AvailableModels) > 0 {
			m.ModelIndex = movePagedSelection(m.ModelIndex, len(m.AvailableModels), m.modelPanelPageSize(), "left")
		}
		return m, nil
	case tea.KeyRight:
		if len(m.AvailableModels) > 0 {
			m.ModelIndex = movePagedSelection(m.ModelIndex, len(m.AvailableModels), m.modelPanelPageSize(), "right")
		}
		return m, nil
	case tea.KeyEnter:
		if len(m.AvailableModels) == 0 {
			return m, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Switching model...", false)
		return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_model", Value: m.AvailableModels[m.ModelIndex]})
	case tea.KeyRunes:
		if len(msg.Runes) != 1 {
			return m, nil
		}
		switch strings.ToLower(string(msg.Runes)) {
		case "r":
			m.Status = StatusPreparing
			m.setNotice("Refreshing models...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "refresh_models"})
		case "c":
			m.ActivePanel = PanelNone
			m.Input = []rune("/model custom ")
			m.Cursor = len(m.Input)
			m.setNotice("Custom model command ready.", false)
			return m, nil
		}
	}
	return m, nil
}

func (m *Model) handleProviderKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyUp:
		if len(m.AvailableProviders) > 0 {
			m.ProviderIndex = cycleIndex(m.ProviderIndex, len(m.AvailableProviders), -1)
		}
		return m, nil
	case tea.KeyDown:
		if len(m.AvailableProviders) > 0 {
			m.ProviderIndex = cycleIndex(m.ProviderIndex, len(m.AvailableProviders), 1)
		}
		return m, nil
	case tea.KeyLeft:
		if len(m.AvailableProviders) > 0 {
			m.ProviderIndex = movePagedSelection(m.ProviderIndex, len(m.AvailableProviders), m.providerPanelPageSize(), "left")
		}
		return m, nil
	case tea.KeyRight:
		if len(m.AvailableProviders) > 0 {
			m.ProviderIndex = movePagedSelection(m.ProviderIndex, len(m.AvailableProviders), m.providerPanelPageSize(), "right")
		}
		return m, nil
	case tea.KeyEnter:
		if len(m.AvailableProviders) == 0 {
			return m, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Switching provider...", false)
		return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_provider", Value: m.AvailableProviders[m.ProviderIndex]})
	case tea.KeyRunes:
		if len(msg.Runes) != 1 {
			return m, nil
		}
		if strings.ToLower(string(msg.Runes)) == "r" {
			m.Status = StatusPreparing
			m.setNotice("Refreshing providers and models...", false)
			return m, tea.Batch(
				sendBridgeCommand(m.bridge, bridgeCommand{Type: "refresh_models"}),
				sendBridgeCommand(m.bridge, bridgeCommand{Type: "list_providers"}),
			)
		}
	}
	return m, nil
}

func (m *Model) handleAuthKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyUp:
		m.moveAuthStep(-1)
		return m, nil
	case tea.KeyDown, tea.KeyTab:
		m.moveAuthStep(1)
		return m, nil
	case tea.KeyEnter:
		if m.AuthStep == AuthStepConfirm {
			provider := strings.TrimSpace(string(m.AuthProvider))
			providerType := strings.TrimSpace(string(m.AuthProviderType))
			apiKey := strings.TrimSpace(string(m.AuthAPIKey))
			model := strings.TrimSpace(string(m.AuthModel))
			if provider == "" {
				m.AuthStep = AuthStepProvider
				m.AuthCursor = len(m.AuthProvider)
				m.setNotice("Provider is required.", true)
				return m, nil
			}
			if providerType == "" {
				m.AuthStep = AuthStepProviderType
				m.AuthCursor = len(m.AuthProviderType)
				m.setNotice("Provider type is required.", true)
				return m, nil
			}
			if apiKey == "" {
				m.AuthStep = AuthStepAPIKey
				m.AuthCursor = len(m.AuthAPIKey)
				m.setNotice("API key is required.", true)
				return m, nil
			}
			m.AuthSaving = true
			m.Status = StatusPreparing
			m.setNotice("Saving HTTP login...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{
				Type:            "login",
				ProviderBaseURL: provider,
				ProviderType:    providerType,
				APIKey:          apiKey,
				Model:           model,
			})
		}
		return m, m.advanceAuthStepOnEnter()
	case tea.KeyHome:
		m.AuthCursor = 0
		return m, nil
	case tea.KeyEnd:
		m.AuthCursor = m.currentAuthFieldLength()
		return m, nil
	case tea.KeyCtrlU:
		m.clearAuthField()
		return m, nil
	case tea.KeyCtrlK:
		m.deleteAuthToEnd()
		return m, nil
	case tea.KeyCtrlW:
		m.deleteAuthWordBackward()
		return m, nil
	case tea.KeyBackspace:
		m.deleteAuthBackward()
		return m, nil
	case tea.KeyDelete, tea.KeyCtrlD:
		m.deleteAuthForward()
		return m, nil
	case tea.KeyLeft:
		if m.AuthCursor > 0 {
			m.AuthCursor--
		}
		return m, nil
	case tea.KeyRight:
		if m.AuthCursor < m.currentAuthFieldLength() {
			m.AuthCursor++
		}
		return m, nil
	case tea.KeySpace:
		m.insertAuthRunes([]rune{' '})
		return m, nil
	case tea.KeyRunes:
		if msg.Alt && len(msg.Runes) == 1 {
			switch msg.Runes[0] {
			case '1':
				m.AuthStep = AuthStepProvider
				m.AuthCursor = len(m.AuthProvider)
				return m, nil
			case '2':
				m.AuthStep = AuthStepProviderType
				m.AuthCursor = len(m.AuthProviderType)
				return m, nil
			case '3':
				m.AuthStep = AuthStepAPIKey
				m.AuthCursor = len(m.AuthAPIKey)
				return m, nil
			case '4':
				m.AuthStep = AuthStepModel
				m.AuthCursor = len(m.AuthModel)
				return m, nil
			}
		}
		m.insertAuthRunes(filterAuthInputRunes(msg.Runes))
		return m, nil
	default:
		return m, nil
	}
}

func (m *Model) submitInput() tea.Cmd {
	query := strings.TrimSpace(string(m.Input))
	if query == "" {
		return nil
	}

	m.TranscriptOffset = 0
	m.Input = m.Input[:0]
	m.Cursor = 0
	m.clearComposerComposition()

	handled, cmd := m.handleSlashCommand(query)
	if handled {
		return cmd
	}
	if strings.HasPrefix(query, "/") {
		if m.bridge == nil {
			m.Status = StatusError
			m.setNotice("Bridge not ready yet.", true)
			return nil
		}
		m.Status = StatusPreparing
		if !m.BridgeReady {
			m.setNotice("Bridge starting, queued command...", false)
		} else {
			m.setNotice("Running command...", false)
		}
		return sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	}

	if m.bridge == nil {
		m.Status = StatusError
		m.setNotice("Bridge not ready yet.", true)
		return nil
	}

	m.Status = StatusPreparing
	if !m.BridgeReady {
		m.setNotice("Bridge starting, queued query...", false)
	} else {
		m.setNotice("Submitting query...", false)
	}
	return sendBridgeCommand(m.bridge, bridgeCommand{Type: "submit", Text: query})
}

func (m *Model) handleSlashCommand(query string) (bool, tea.Cmd) {
	switch {
	case query == "/quit" || query == "/exit":
		m.ShouldQuit = true
		m.QuitWithSummary = false
		if m.bridge != nil {
			m.bridge.Close()
		}
		return true, tea.Quit
	case query == "/help":
		m.Items = append(m.Items, Message{
			Role: "system",
			Kind: "system_hint",
			Text: slashHelpText(),
		})
		m.invalidateTranscriptCache()
		m.setNotice("Command reference appended to transcript.", false)
		return true, nil
	case query == "/cancel":
		m.setNotice("No cancellable in-flight operation in v2 bridge mode.", true)
		return true, nil
	case query == "/clear":
		m.Status = StatusPreparing
		m.setNotice("Starting a new session...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "new_session"})
	case query == "/new":
		m.Status = StatusPreparing
		m.setNotice("Creating a new session...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "new_session"})
	case query == "/plan show":
		m.ActivePanel = PanelPlans
		m.setNotice("Plan panel opened.", false)
		return true, nil
	case query == "/plan", query == "/plan create":
		m.ActivePanel = PanelPlans
		m.setNotice("Usage: /plan create <task>", true)
		return true, nil
	case query == "/plan clear":
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Clearing execution plan...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case query == "/plan reopen":
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Reopening execution plan...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case query == "/plan run":
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Running next execution plan step...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case query == "/plan done":
		m.setNotice("Usage: /plan done <step-id|index>", true)
		return true, nil
	case strings.HasPrefix(query, "/plan done "):
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Marking plan step completed...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case strings.HasPrefix(query, "/plan run "):
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Running selected execution plan step...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case strings.HasPrefix(query, "/plan create "):
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Building execution plan...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case strings.HasPrefix(query, "/plan revise "):
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Revising execution plan...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case strings.HasPrefix(query, "/plan summary "):
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Updating plan summary...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case strings.HasPrefix(query, "/plan objective "):
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Updating plan objective...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case strings.HasPrefix(query, "/plan add "):
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Adding plan step...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case strings.HasPrefix(query, "/plan update "):
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Updating plan step...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case strings.HasPrefix(query, "/plan remove "):
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Removing plan step...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case strings.HasPrefix(query, "/plan status "):
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Updating plan step status...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case query == "/plan accept":
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Accepting execution plan...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case strings.HasPrefix(query, "/plan accept "):
		m.ActivePanel = PanelPlans
		m.Status = StatusPreparing
		m.setNotice("Accepting execution plan...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	case strings.HasPrefix(query, "/plan "):
		m.ActivePanel = PanelPlans
		m.setNotice("Unknown /plan subcommand. Use /plan create, revise, summary, objective, add, update, remove, status, run, done, accept, reopen, show, or clear.", true)
		return true, nil
	case query == "/sessions" || query == "/resume":
		m.ActivePanel = PanelSessions
		m.setNotice("Sessions panel opened.", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "list_sessions"})
	case strings.HasPrefix(query, "/resume "):
		id := strings.TrimSpace(strings.TrimPrefix(query, "/resume "))
		if id == "" {
			m.setNotice("Usage: /resume <session-id>", true)
			return true, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Loading session...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "load_session", ID: id})
	case query == "/review":
		if len(m.PendingReviews) == 0 {
			m.setNotice("No pending approvals.", false)
			return true, nil
		}
		m.ActivePanel = PanelApprovals
		m.ApprovalIndex = maxInt(0, len(m.PendingReviews)-1)
		m.ApprovalPreview = ApprovalFull
		m.ApprovalPreviewOffset = 0
		m.setNotice("Approval panel opened.", false)
		return true, nil
	case strings.HasPrefix(query, "/review "):
		id := strings.TrimSpace(strings.TrimPrefix(query, "/review "))
		if id == "" {
			m.setNotice("Usage: /review <id>", true)
			return true, nil
		}
		index := m.pendingIndexByID(id)
		if index < 0 {
			m.setNotice("Pending operation not found.", true)
			return true, nil
		}
		m.ActivePanel = PanelApprovals
		m.ApprovalIndex = index
		m.ApprovalPreviewOffset = 0
		m.ApprovalPreview = ApprovalFull
		m.setNotice("Approval panel opened for selected item.", false)
		return true, nil
	case query == "/approve":
		if len(m.PendingReviews) == 0 {
			m.setNotice("No pending operations to approve.", false)
			return true, nil
		}
		if len(m.PendingReviews) == 1 {
			m.Status = StatusPreparing
			m.setNotice("Approving pending review...", false)
			return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "approve", ID: m.PendingReviews[0].ID})
		}
		m.setNotice("Use /approve <id>, /approve low, or /approve all.", true)
		return true, nil
	case query == "/approve low":
		if len(m.PendingReviews) == 0 {
			m.setNotice("No pending operations to approve.", false)
			return true, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Approving all non-high-risk pending operations...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "approve_low"})
	case query == "/approve all":
		if len(m.PendingReviews) == 0 {
			m.setNotice("No pending operations to approve.", false)
			return true, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Approving all pending operations...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "approve_all"})
	case strings.HasPrefix(query, "/approve "):
		id := strings.TrimSpace(strings.TrimPrefix(query, "/approve "))
		if id == "" {
			m.setNotice("Usage: /approve <id> | /approve low | /approve all", true)
			return true, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Approving review...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "approve", ID: id})
	case query == "/reject":
		if len(m.PendingReviews) == 0 {
			m.setNotice("No pending operations to reject.", false)
			return true, nil
		}
		if len(m.PendingReviews) == 1 {
			m.Status = StatusPreparing
			m.setNotice("Rejecting pending review...", false)
			return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "reject", ID: m.PendingReviews[0].ID})
		}
		m.setNotice("Use /reject <id> or /reject all.", true)
		return true, nil
	case query == "/reject all":
		if len(m.PendingReviews) == 0 {
			m.setNotice("No pending operations to reject.", false)
			return true, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Rejecting all pending operations...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "reject_all"})
	case strings.HasPrefix(query, "/reject "):
		id := strings.TrimSpace(strings.TrimPrefix(query, "/reject "))
		if id == "" {
			m.setNotice("Usage: /reject <id> | /reject all", true)
			return true, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Rejecting review...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "reject", ID: id})
	case query == "/model":
		m.ActivePanel = PanelModels
		m.setNotice("Model picker opened.", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "list_models"})
	case query == "/model refresh":
		m.ActivePanel = PanelModels
		m.Status = StatusPreparing
		m.setNotice("Refreshing models...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "refresh_models"})
	case query == "/model custom":
		m.setNotice("Usage: /model custom <id>", true)
		return true, nil
	case strings.HasPrefix(query, "/model custom "):
		model := strings.TrimSpace(strings.TrimPrefix(query, "/model custom "))
		if model == "" {
			m.setNotice("Usage: /model custom <id>", true)
			return true, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Switching model...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_model", Value: model})
	case strings.HasPrefix(query, "/model "):
		model := strings.TrimSpace(strings.TrimPrefix(query, "/model "))
		if model == "" {
			m.setNotice("Usage: /model <name>", true)
			return true, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Switching model...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_model", Value: model})
	case query == "/provider":
		m.ActivePanel = PanelProviders
		m.setNotice("Provider picker opened.", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "list_providers"})
	case query == "/provider refresh":
		m.ActivePanel = PanelProviders
		m.Status = StatusPreparing
		m.setNotice("Refreshing providers and models...", false)
		return true, tea.Batch(
			sendBridgeCommand(m.bridge, bridgeCommand{Type: "refresh_models"}),
			sendBridgeCommand(m.bridge, bridgeCommand{Type: "list_providers"}),
		)
	case query == "/provider profile":
		m.setNotice("Usage: /provider profile <openai|gemini|anthropic|custom> [url] | /provider profile clear [url] | /provider profile list", true)
		return true, nil
	case query == "/provider profile list":
		m.Status = StatusPreparing
		m.setNotice("Loading provider profile overrides...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "list_provider_profiles"})
	case query == "/provider type":
		m.setNotice("Usage: /provider type <openai-compatible|openai-responses|gemini|anthropic> [url] | /provider type clear [url] | /provider type list", true)
		return true, nil
	case query == "/provider type list":
		m.Status = StatusPreparing
		m.setNotice("Loading provider type overrides...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "list_provider_types"})
	case query == "/provider format":
		m.setNotice("Usage: /provider format <openai_chat|openai_responses|anthropic_messages|gemini_generate_content> [url] | /provider format clear [url] | /provider format list", true)
		return true, nil
	case query == "/provider format list":
		m.Status = StatusPreparing
		m.setNotice("Loading provider transport format overrides...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "list_provider_formats"})
	case query == "/provider endpoint":
		m.setNotice("Usage: /provider endpoint <responses|chat_completions|models|anthropic_messages|gemini_generate_content> <path|url> [provider] | /provider endpoint clear <kind> [provider] | /provider endpoint list", true)
		return true, nil
	case query == "/provider endpoint list":
		m.Status = StatusPreparing
		m.setNotice("Loading provider endpoint overrides...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "list_provider_endpoints"})
	case query == "/provider name":
		m.setNotice("Usage: /provider name <display_name> | /provider name clear [url] | /provider name list", true)
		return true, nil
	case query == "/provider name list":
		m.Status = StatusPreparing
		m.setNotice("Loading custom provider names...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "list_provider_names"})
	case strings.HasPrefix(query, "/provider name clear"):
		tail := strings.TrimSpace(strings.TrimPrefix(query, "/provider name clear"))
		m.Status = StatusPreparing
		m.setNotice("Clearing custom provider name...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "clear_provider_name", Value: tail})
	case strings.HasPrefix(query, "/provider name "):
		name := strings.TrimSpace(strings.TrimPrefix(query, "/provider name "))
		if name == "" {
			m.setNotice("Usage: /provider name <display_name>", true)
			return true, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Saving custom provider name...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_provider_name", Name: name})
	case strings.HasPrefix(query, "/provider profile clear"):
		tail := strings.TrimSpace(strings.TrimPrefix(query, "/provider profile clear"))
		m.Status = StatusPreparing
		m.setNotice("Clearing provider profile override...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "clear_provider_profile", Value: tail})
	case strings.HasPrefix(query, "/provider type clear"):
		tail := strings.TrimSpace(strings.TrimPrefix(query, "/provider type clear"))
		m.Status = StatusPreparing
		m.setNotice("Clearing provider type override...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "clear_provider_type", Value: tail})
	case strings.HasPrefix(query, "/provider type "):
		tail := strings.TrimSpace(strings.TrimPrefix(query, "/provider type "))
		parts := strings.Fields(tail)
		if len(parts) == 0 {
			m.setNotice("Usage: /provider type <openai-compatible|openai-responses|gemini|anthropic> [url]", true)
			return true, nil
		}
		providerType := strings.ToLower(parts[0])
		if providerType != "openai-compatible" && providerType != "openai-responses" && providerType != "gemini" && providerType != "anthropic" {
			m.setNotice("Provider type must be openai-compatible, openai-responses, gemini, or anthropic.", true)
			return true, nil
		}
		provider := ""
		if len(parts) > 1 {
			provider = strings.Join(parts[1:], " ")
		}
		m.Status = StatusPreparing
		m.setNotice("Setting provider type override...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_provider_type", ProviderType: providerType, Value: provider})
	case strings.HasPrefix(query, "/provider profile "):
		tail := strings.TrimSpace(strings.TrimPrefix(query, "/provider profile "))
		parts := strings.Fields(tail)
		if len(parts) == 0 {
			m.setNotice("Usage: /provider profile <openai|gemini|anthropic|custom> [url]", true)
			return true, nil
		}
		profile := strings.ToLower(parts[0])
		if profile != "openai" && profile != "gemini" && profile != "anthropic" && profile != "custom" {
			m.setNotice("Profile must be openai, gemini, anthropic, or custom.", true)
			return true, nil
		}
		provider := ""
		if len(parts) > 1 {
			provider = strings.Join(parts[1:], " ")
		}
		m.Status = StatusPreparing
		m.setNotice("Setting provider profile override...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_provider_profile", Profile: profile, Value: provider})
	case strings.HasPrefix(query, "/provider format clear"):
		tail := strings.TrimSpace(strings.TrimPrefix(query, "/provider format clear"))
		m.Status = StatusPreparing
		m.setNotice("Clearing provider transport format override...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "clear_provider_format", Value: tail})
	case strings.HasPrefix(query, "/provider format "):
		tail := strings.TrimSpace(strings.TrimPrefix(query, "/provider format "))
		parts := strings.Fields(tail)
		if len(parts) == 0 {
			m.setNotice("Usage: /provider format <openai_chat|openai_responses|anthropic_messages|gemini_generate_content> [url]", true)
			return true, nil
		}
		format := strings.ToLower(parts[0])
		if format != "openai_chat" && format != "openai_responses" && format != "anthropic_messages" && format != "gemini_generate_content" {
			m.setNotice("Format must be openai_chat, openai_responses, anthropic_messages, or gemini_generate_content.", true)
			return true, nil
		}
		provider := ""
		if len(parts) > 1 {
			provider = strings.Join(parts[1:], " ")
		}
		m.Status = StatusPreparing
		m.setNotice("Setting provider transport format override...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_provider_format", Format: format, Value: provider})
	case strings.HasPrefix(query, "/provider endpoint clear"):
		tail := strings.TrimSpace(strings.TrimPrefix(query, "/provider endpoint clear"))
		parts := strings.Fields(tail)
		if len(parts) == 0 || !isProviderEndpointKind(parts[0]) {
			m.setNotice("Usage: /provider endpoint clear <kind> [provider]", true)
			return true, nil
		}
		provider := ""
		if len(parts) > 1 {
			provider = strings.Join(parts[1:], " ")
		}
		m.Status = StatusPreparing
		m.setNotice("Clearing provider endpoint override...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "clear_provider_endpoint", Kind: parts[0], Value: provider})
	case strings.HasPrefix(query, "/provider endpoint "):
		tail := strings.TrimSpace(strings.TrimPrefix(query, "/provider endpoint "))
		parts := strings.Fields(tail)
		if len(parts) < 2 || !isProviderEndpointKind(parts[0]) {
			m.setNotice("Usage: /provider endpoint <kind> <path|url> [provider]", true)
			return true, nil
		}
		kind := parts[0]
		endpoint := parts[1]
		provider := ""
		if len(parts) > 2 {
			provider = strings.Join(parts[2:], " ")
		}
		m.Status = StatusPreparing
		m.setNotice("Setting provider endpoint override...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_provider_endpoint", Kind: kind, Endpoint: endpoint, Value: provider})
	case strings.HasPrefix(query, "/provider "):
		provider := strings.TrimSpace(strings.TrimPrefix(query, "/provider "))
		if provider == "" {
			m.setNotice("Usage: /provider <base_url|openai|gemini|anthropic>", true)
			return true, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Switching provider...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_provider", Value: provider})
	case query == "/login":
		m.openAuthPanel()
		m.setNotice("Login panel opened. Loading saved credential...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "get_login_defaults"})
	case query == "/logout":
		m.Status = StatusPreparing
		m.setNotice("Logging out from HTTP provider...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "logout"})
	case query == "/auth":
		m.Items = append(m.Items, Message{Role: "system", Kind: "system_hint", Text: m.formatAuthSummary()})
		m.invalidateTranscriptCache()
		m.setNotice("Auth status appended to transcript.", false)
		return true, nil
	case strings.HasPrefix(query, "/load "):
		id := strings.TrimSpace(strings.TrimPrefix(query, "/load "))
		if id == "" {
			m.setNotice("Usage: /load <session-id>", true)
			return true, nil
		}
		m.Status = StatusPreparing
		m.setNotice("Loading session...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "load_session", ID: id})
	default:
		return false, nil
	}
}

func (m *Model) formatAuthSummary() string {
	mode := m.Auth.Mode
	if mode == "" {
		mode = "local"
	}
	provider := m.Auth.Provider
	if strings.TrimSpace(provider) == "" {
		provider = m.CurrentProvider
	}
	model := m.Auth.Model
	if strings.TrimSpace(model) == "" {
		model = m.CurrentModel
	}
	persist := m.Auth.PersistenceLabel
	if persist == "" {
		persist = "unavailable"
	}
	return fmt.Sprintf(
		"Auth mode: %s\nProvider: %s\nModel: %s\nCredential source: %s\nHTTP ready: %t\nPersistence: %s%s",
		mode,
		emptyFallback(provider, "none"),
		emptyFallback(model, "none"),
		emptyFallback(m.Auth.CredentialSource, "none"),
		m.Auth.HTTPReady,
		persist,
		formatOptionalDetail(m.Auth.PersistencePath),
	)
}

func formatOptionalDetail(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	return fmt.Sprintf(" (%s)", trimmed)
}

func emptyFallback(value, fallback string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fallback
	}
	return trimmed
}

func (m *Model) openAuthPanel() {
	m.ActivePanel = PanelAuth
	m.AuthSaving = false
	m.AuthStep = AuthStepProvider
	if len(m.AuthProvider) == 0 {
		provider := strings.TrimSpace(m.CurrentProvider)
		if provider == "" || provider == "local-core" || provider == "none" {
			provider = strings.TrimSpace(m.Auth.Provider)
		}
		m.AuthProvider = []rune(provider)
	}
	if len(m.AuthModel) == 0 {
		m.AuthModel = []rune(strings.TrimSpace(m.CurrentModel))
	}
	m.AuthCursor = len(m.AuthProvider)
}

func (m *Model) moveAuthStep(delta int) {
	steps := []AuthStep{AuthStepProvider, AuthStepProviderType, AuthStepAPIKey, AuthStepModel, AuthStepConfirm}
	currentIndex := 0
	for index, step := range steps {
		if step == m.AuthStep {
			currentIndex = index
			break
		}
	}
	nextIndex := clampInt(currentIndex+delta, 0, len(steps)-1)
	m.AuthStep = steps[nextIndex]
	m.AuthCursor = m.currentAuthFieldLength()
}

func (m *Model) advanceAuthStepOnEnter() tea.Cmd {
	switch m.AuthStep {
	case AuthStepProvider:
		m.AuthStep = AuthStepProviderType
		m.AuthCursor = len(m.AuthProviderType)
		provider := strings.TrimSpace(string(m.AuthProvider))
		if provider != "" && m.bridge != nil && m.BridgeReady {
			return sendBridgeCommand(m.bridge, bridgeCommand{
				Type:            "get_login_defaults",
				ProviderBaseURL: provider,
			})
		}
	case AuthStepProviderType:
		if len(m.AuthAPIKey) > 0 {
			if len(m.AuthModel) > 0 {
				m.AuthStep = AuthStepConfirm
				m.AuthCursor = 0
				return nil
			}
			m.AuthStep = AuthStepModel
			m.AuthCursor = len(m.AuthModel)
			return nil
		}
		m.AuthStep = AuthStepAPIKey
		m.AuthCursor = len(m.AuthAPIKey)
	case AuthStepAPIKey:
		if len(m.AuthModel) > 0 {
			m.AuthStep = AuthStepConfirm
			m.AuthCursor = 0
			return nil
		}
		m.AuthStep = AuthStepModel
		m.AuthCursor = len(m.AuthModel)
	case AuthStepModel:
		m.AuthStep = AuthStepConfirm
		m.AuthCursor = 0
	default:
		m.moveAuthStep(1)
	}
	return nil
}

func (m *Model) currentAuthFieldLength() int {
	switch m.AuthStep {
	case AuthStepProvider:
		return len(m.AuthProvider)
	case AuthStepProviderType:
		return len(m.AuthProviderType)
	case AuthStepAPIKey:
		return len(m.AuthAPIKey)
	case AuthStepModel:
		return len(m.AuthModel)
	default:
		return 0
	}
}

func (m *Model) currentAuthField() *[]rune {
	switch m.AuthStep {
	case AuthStepProvider:
		return &m.AuthProvider
	case AuthStepProviderType:
		return &m.AuthProviderType
	case AuthStepAPIKey:
		return &m.AuthAPIKey
	case AuthStepModel:
		return &m.AuthModel
	default:
		return nil
	}
}

func (m *Model) insertAuthRunes(values []rune) {
	field := m.currentAuthField()
	if field == nil || len(values) == 0 {
		return
	}
	cursor := clampInt(m.AuthCursor, 0, len(*field))
	next := make([]rune, 0, len(*field)+len(values))
	next = append(next, (*field)[:cursor]...)
	next = append(next, values...)
	next = append(next, (*field)[cursor:]...)
	*field = next
	m.AuthCursor = cursor + len(values)
}

func filterAuthInputRunes(values []rune) []rune {
	filtered := values[:0]
	for _, value := range values {
		if isWindowsIgnoredInputRune(value) {
			continue
		}
		if unicode.IsControl(value) {
			continue
		}
		filtered = append(filtered, value)
	}
	return filtered
}

func (m *Model) deleteAuthForward() {
	field := m.currentAuthField()
	if field == nil {
		return
	}
	cursor := clampInt(m.AuthCursor, 0, len(*field))
	if cursor >= len(*field) {
		return
	}
	next := make([]rune, 0, len(*field)-1)
	next = append(next, (*field)[:cursor]...)
	next = append(next, (*field)[cursor+1:]...)
	*field = next
}

func (m *Model) deleteAuthBackward() {
	field := m.currentAuthField()
	if field == nil || m.AuthCursor <= 0 || len(*field) == 0 {
		return
	}
	cursor := clampInt(m.AuthCursor, 0, len(*field))
	next := make([]rune, 0, len(*field)-1)
	next = append(next, (*field)[:cursor-1]...)
	next = append(next, (*field)[cursor:]...)
	*field = next
	m.AuthCursor = cursor - 1
}

func (m *Model) deleteAuthWordBackward() {
	field := m.currentAuthField()
	if field == nil {
		return
	}
	next, cursor := deleteWordBackwardRunes(*field, m.AuthCursor)
	*field = next
	m.AuthCursor = cursor
}

func (m *Model) deleteAuthToEnd() {
	field := m.currentAuthField()
	if field == nil {
		return
	}
	cursor := clampInt(m.AuthCursor, 0, len(*field))
	*field = append([]rune{}, (*field)[:cursor]...)
}

func (m *Model) clearAuthField() {
	field := m.currentAuthField()
	if field == nil {
		return
	}
	*field = (*field)[:0]
	m.AuthCursor = 0
}

func (m *Model) setNotice(text string, isError bool) {
	m.Notice = strings.TrimSpace(text)
	m.NoticeIsError = isError
}

func (m *Model) shouldSuppressPaste(values []rune) bool {
	if !m.MouseCapture || len(values) == 0 {
		return false
	}
	if m.IgnorePasteUntil.IsZero() {
		return false
	}
	if time.Now().After(m.IgnorePasteUntil) {
		m.IgnorePasteUntil = time.Time{}
		return false
	}
	return true
}

func (m *Model) invalidateTranscriptCache() {
	m.transcriptVersion++
	m.invalidateTranscriptRenderCache()
	m.transcriptStaticCacheWidth = 0
	m.transcriptStaticCacheLines = nil
}

func (m *Model) invalidateTranscriptRenderCache() {
	m.transcriptCacheWidth = 0
	m.transcriptCacheVersion = 0
	m.transcriptCacheLines = nil
	m.transcriptLiveCacheWidth = 0
	m.transcriptLiveCacheText = ""
	m.transcriptLiveCacheLines = nil
}

func (m *Model) resetTranscriptMessageCache() {
	m.transcriptMessageCache = nil
}

func (m *Model) extendTranscriptMessageCache(count int) {
	if count <= 0 {
		return
	}
	m.transcriptMessageCache = append(m.transcriptMessageCache, make([]transcriptMessageCacheEntry, count)...)
}

func (m *Model) insertRunes(values []rune) {
	values = normalizeComposerRunes(values)
	if len(values) == 0 {
		return
	}
	if m.Cursor < 0 {
		m.Cursor = 0
	}
	if m.Cursor > len(m.Input) {
		m.Cursor = len(m.Input)
	}

	next := make([]rune, 0, len(m.Input)+len(values))
	next = append(next, m.Input[:m.Cursor]...)
	next = append(next, values...)
	next = append(next, m.Input[m.Cursor:]...)
	m.Input = next
	m.Cursor += len(values)
	m.clearComposerComposition()
	m.resetSlashSelection()
}

func (m *Model) deleteForward() {
	if m.Cursor < 0 || m.Cursor >= len(m.Input) || len(m.Input) == 0 {
		return
	}
	next := make([]rune, 0, len(m.Input)-1)
	next = append(next, m.Input[:m.Cursor]...)
	next = append(next, m.Input[m.Cursor+1:]...)
	m.Input = next
	m.clearComposerComposition()
	m.resetSlashSelection()
}

func (m *Model) deleteComposerWordBackward() {
	m.Input, m.Cursor = deleteWordBackwardRunes(m.Input, m.Cursor)
	m.clearComposerComposition()
	m.resetSlashSelection()
}

func (m *Model) deleteComposerToEnd() {
	cursor := clampInt(m.Cursor, 0, len(m.Input))
	m.Input = append([]rune{}, m.Input[:cursor]...)
	m.clearComposerComposition()
	m.resetSlashSelection()
}

func (m *Model) clearComposerInput() {
	m.Input = m.Input[:0]
	m.Cursor = 0
	m.clearComposerComposition()
	m.resetSlashSelection()
}

func normalizeComposerRunes(values []rune) []rune {
	if len(values) == 0 {
		return nil
	}

	stripStandaloneCursorArtifacts := len(values) > 1 && hasStandaloneComposerCursorLine(values)
	normalized := make([]rune, 0, len(values))
	for index := 0; index < len(values); index++ {
		r := values[index]
		switch r {
		case '\r':
			if index+1 < len(values) && values[index+1] == '\n' {
				continue
			}
			normalized = append(normalized, '\n')
		case '\t':
			normalized = append(normalized, ' ', ' ', ' ', ' ')
		case '\n':
			normalized = append(normalized, '\n')
		case '\u00a0':
			normalized = append(normalized, ' ')
		default:
			if stripStandaloneCursorArtifacts && isStandaloneComposerCursorLineRune(values, index) {
				continue
			}
			if isWindowsIgnoredInputRune(r) {
				continue
			}
			if unicode.IsControl(r) {
				continue
			}
			normalized = append(normalized, r)
		}
	}
	return normalized
}

func defaultClipboardTextReader() (string, error) {
	switch runtime.GOOS {
	case "windows":
		command := exec.Command(
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$text = Get-Clipboard -Raw; if ($null -ne $text) { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write($text) }",
		)
		output, err := command.Output()
		if err != nil {
			return "", err
		}
		return string(output), nil
	default:
		return "", fmt.Errorf("unsupported platform %s", runtime.GOOS)
	}
}

func isWindowsIgnoredInputRune(value rune) bool {
	switch value {
	case 0, '\ufeff', '\u200b', '\u200c', '\u200d', '\u2060':
		return true
	default:
		return false
	}
}

func hasStandaloneComposerCursorLine(values []rune) bool {
	for start := 0; start <= len(values); {
		end := start
		for end < len(values) && values[end] != '\n' && values[end] != '\r' {
			end++
		}
		if lineContainsOnlyStandaloneComposerCursor(values[start:end]) {
			return true
		}
		if end >= len(values) {
			return false
		}
		if values[end] == '\r' && end+1 < len(values) && values[end+1] == '\n' {
			start = end + 2
			continue
		}
		start = end + 1
	}
	return false
}

func isStandaloneComposerCursorLineRune(values []rune, index int) bool {
	if index < 0 || index >= len(values) || values[index] != composerCursorRune {
		return false
	}

	start := index
	for start > 0 && values[start-1] != '\n' && values[start-1] != '\r' {
		start--
	}

	end := index + 1
	for end < len(values) && values[end] != '\n' && values[end] != '\r' {
		end++
	}

	return lineContainsOnlyStandaloneComposerCursor(values[start:end])
}

func lineContainsOnlyStandaloneComposerCursor(values []rune) bool {
	cursorCount := 0
	for _, value := range values {
		switch {
		case value == composerCursorRune:
			cursorCount++
		case unicode.IsSpace(value):
			continue
		default:
			return false
		}
	}
	return cursorCount == 1
}

func deleteWordBackwardRunes(values []rune, cursor int) ([]rune, int) {
	if len(values) == 0 || cursor <= 0 {
		return values, clampInt(cursor, 0, len(values))
	}
	cursor = clampInt(cursor, 0, len(values))
	start := cursor
	for start > 0 && unicode.IsSpace(values[start-1]) {
		start--
	}
	for start > 0 && !unicode.IsSpace(values[start-1]) {
		start--
	}
	next := make([]rune, 0, len(values)-(cursor-start))
	next = append(next, values[:start]...)
	next = append(next, values[cursor:]...)
	return next, start
}

func (m *Model) deleteBackward() {
	if m.Cursor <= 0 || len(m.Input) == 0 {
		return
	}

	next := make([]rune, 0, len(m.Input)-1)
	next = append(next, m.Input[:m.Cursor-1]...)
	next = append(next, m.Input[m.Cursor:]...)
	m.Input = next
	m.Cursor--
	m.clearComposerComposition()
	m.resetSlashSelection()
}

func (m *Model) setComposerComposition(text []rune, cursor int) {
	normalized := normalizeComposerRunes(text)
	m.Composition = append(m.Composition[:0], normalized...)
	m.CompositionCursor = clampInt(cursor, 0, len(m.Composition))
	m.resetSlashSelection()
}

func (m *Model) commitComposerComposition(text []rune) {
	m.insertRunes(text)
	m.clearComposerComposition()
}

func (m *Model) clearComposerComposition() {
	m.Composition = m.Composition[:0]
	m.CompositionCursor = 0
}

func isDefaultEmptyState(items []Message) bool {
	return len(items) == 1 &&
		items[0].Role == "system" &&
		items[0].Kind == "system_hint" &&
		items[0].Text == "No messages in the current session. Start typing."
}

func isStartupBridgePlaceholder(items []Message) bool {
	return len(items) == 1 &&
		items[0].Role == "system" &&
		items[0].Kind == "system_hint" &&
		items[0].Text == "Starting Bubble Tea v2 bridge..."
}

func cloneMessages(items []Message) []Message {
	if len(items) == 0 {
		return nil
	}
	cloned := make([]Message, len(items))
	copy(cloned, items)
	return cloned
}

func cloneReviews(items []BridgeReview) []BridgeReview {
	if len(items) == 0 {
		return nil
	}
	cloned := make([]BridgeReview, len(items))
	copy(cloned, items)
	return cloned
}

func cloneSessions(items []BridgeSession) []BridgeSession {
	if len(items) == 0 {
		return nil
	}
	cloned := make([]BridgeSession, len(items))
	copy(cloned, items)
	for index := range cloned {
		if len(items[index].Tags) == 0 {
			continue
		}
		cloned[index].Tags = append([]string(nil), items[index].Tags...)
	}
	return cloned
}

func cloneExecutionPlan(plan *BridgeExecutionPlan) ExecutionPlan {
	if plan == nil {
		return ExecutionPlan{}
	}
	cloned := ExecutionPlan{
		CapturedAt:      plan.CapturedAt,
		SourcePreview:   plan.SourcePreview,
		ProjectRoot:     plan.ProjectRoot,
		Summary:         plan.Summary,
		Objective:       plan.Objective,
		AcceptedAt:      plan.AcceptedAt,
		AcceptedSummary: plan.AcceptedSummary,
	}
	if len(plan.Steps) == 0 {
		return cloned
	}
	cloned.Steps = make([]ExecutionPlanStep, len(plan.Steps))
	for index, step := range plan.Steps {
		cloned.Steps[index] = ExecutionPlanStep{
			ID:               step.ID,
			Title:            step.Title,
			Details:          step.Details,
			Status:           step.Status,
			Evidence:         append([]string(nil), step.Evidence...),
			FilePaths:        append([]string(nil), step.FilePaths...),
			RecentToolResult: step.RecentToolResult,
		}
	}
	return cloned
}

func cloneStrings(items []string) []string {
	if len(items) == 0 {
		return nil
	}
	cloned := make([]string, len(items))
	copy(cloned, items)
	return cloned
}

func cloneManagedSkills(items []BridgeManagedSkill) []BridgeManagedSkill {
	if len(items) == 0 {
		return nil
	}
	cloned := make([]BridgeManagedSkill, len(items))
	copy(cloned, items)
	return cloned
}

func cloneManagedMcpServers(items []BridgeManagedMcpServer) []BridgeManagedMcpServer {
	if len(items) == 0 {
		return nil
	}
	cloned := make([]BridgeManagedMcpServer, len(items))
	copy(cloned, items)
	return cloned
}

func cloneStringMap(items map[string]string) map[string]string {
	if len(items) == 0 {
		return map[string]string{}
	}
	cloned := make(map[string]string, len(items))
	for key, value := range items {
		cloned[key] = value
	}
	return cloned
}

func cloneNestedStringMap(items map[string]map[string]string) map[string]map[string]string {
	if len(items) == 0 {
		return map[string]map[string]string{}
	}
	cloned := make(map[string]map[string]string, len(items))
	for key, value := range items {
		if len(value) == 0 {
			cloned[key] = map[string]string{}
			continue
		}
		inner := make(map[string]string, len(value))
		for innerKey, innerValue := range value {
			inner[innerKey] = innerValue
		}
		cloned[key] = inner
	}
	return cloned
}

func isProviderEndpointKind(value string) bool {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case "responses", "chat_completions", "models", "anthropic_messages", "gemini_generate_content":
		return true
	default:
		return false
	}
}

func (m *Model) ShouldPrintExitSummary() bool {
	return m.QuitWithSummary
}

func (m *Model) ExitSummaryText() string {
	lines := []string{
		formatExitSummaryLine("session", emptyFallback(strings.TrimSpace(m.ActiveSessionID), "none")),
	}

	if title := strings.TrimSpace(m.currentSessionTitle()); title != "" && title != "New session" {
		lines = append(lines, formatExitSummaryLine("title", title))
	}

	lines = append(lines,
		formatExitSummaryLine("project", emptyFallback(strings.TrimSpace(m.AppRoot), "none")),
		formatExitSummaryLine("model", emptyFallback(strings.TrimSpace(m.CurrentModel), "none")),
		formatExitSummaryLine("provider", emptyFallback(strings.TrimSpace(m.providerDisplayName(m.CurrentProvider)), "none")),
		"",
		formatExitSummaryLine("requests", fmt.Sprintf("%d", maxInt(0, m.UsageSummary.Requests))),
		formatExitSummaryLine("prompt", fmt.Sprintf("%d", maxInt(0, m.UsageSummary.PromptTokens))),
		formatExitSummaryLine("cached", fmt.Sprintf("%d", maxInt(0, m.UsageSummary.CachedTokens))),
		formatExitSummaryLine("completion", fmt.Sprintf("%d", maxInt(0, m.UsageSummary.CompletionTokens))),
		formatExitSummaryLine("total", fmt.Sprintf("%d", maxInt(0, m.UsageSummary.TotalTokens))),
	)

	contentWidth := 0
	for _, line := range lines {
		contentWidth = maxInt(contentWidth, lipgloss.Width(line))
	}
	contentWidth = maxInt(contentWidth, lipgloss.Width("CYRENE SESSION CLOSED"))

	title := lipgloss.NewStyle().
		Width(contentWidth).
		Align(lipgloss.Center).
		Background(lipgloss.Color("#FFF")).
		Foreground(lipgloss.Color("#000")).
		Bold(true).
		Render("CYRENE SESSION CLOSED")

	body := []string{title, ""}
	for _, line := range lines {
		body = append(body, padExitSummaryLine(line, contentWidth))
	}

	box := lipgloss.NewStyle().
		Border(lipgloss.NormalBorder()).
		Padding(0, 1).
		Render(strings.Join(body, "\n"))

	return box
}

func formatExitSummaryLine(label, value string) string {
	return fmt.Sprintf("%-11s %s", strings.TrimSpace(label), strings.TrimSpace(value))
}

func padExitSummaryLine(value string, width int) string {
	padding := maxInt(0, width-lipgloss.Width(value))
	return value + strings.Repeat(" ", padding)
}

func (m *Model) currentSessionTitle() string {
	activeID := strings.TrimSpace(m.ActiveSessionID)
	if activeID == "" {
		return ""
	}
	for _, session := range m.Sessions {
		if strings.TrimSpace(session.ID) == activeID {
			return strings.TrimSpace(session.Title)
		}
	}
	return ""
}

func findSelectionIndex(items []BridgeSession, id string, fallback int) int {
	if id == "" {
		return fallback
	}
	for index, item := range items {
		if item.ID == id {
			return index
		}
	}
	return fallback
}

func findStringIndex(items []string, value string, fallback int) int {
	if value == "" {
		return fallback
	}
	for index, item := range items {
		if item == value {
			return index
		}
	}
	return fallback
}

func cycleIndex(selected, total, direction int) int {
	if total <= 0 {
		return 0
	}
	if direction < 0 {
		if selected <= 0 {
			return total - 1
		}
		return selected - 1
	}
	if selected >= total-1 {
		return 0
	}
	return selected + 1
}

func movePagedSelection(selected, total, pageSize int, direction string) int {
	if total <= 0 {
		return 0
	}
	safePageSize := maxInt(1, pageSize)
	currentPage := selected / safePageSize
	maxPage := (total - 1) / safePageSize
	offset := selected % safePageSize
	nextPage := currentPage
	if direction == "left" {
		if currentPage <= 0 {
			nextPage = maxPage
		} else {
			nextPage = currentPage - 1
		}
	} else {
		if currentPage >= maxPage {
			nextPage = 0
		} else {
			nextPage = currentPage + 1
		}
	}
	return minInt(nextPage*safePageSize+offset, total-1)
}

func (m *Model) pendingIndexByID(id string) int {
	for index, item := range m.PendingReviews {
		if item.ID == id {
			return index
		}
	}
	return -1
}

func (m *Model) currentApprovalPreviewText() string {
	if len(m.PendingReviews) == 0 {
		return ""
	}
	selected := m.PendingReviews[clampInt(m.ApprovalIndex, 0, len(m.PendingReviews)-1)]
	if m.ApprovalPreview == ApprovalFull && strings.TrimSpace(selected.PreviewFull) != "" {
		return selected.PreviewFull
	}
	return selected.PreviewSummary
}

func (m *Model) currentApprovalPreviewLineCount() int {
	text := m.currentApprovalPreviewText()
	if text == "" {
		return 1
	}
	return len(strings.Split(text, "\n"))
}

func (m *Model) scrollApprovalPreview(delta int) {
	totalLines := m.currentApprovalPreviewLineCount()
	maxOffset := maxInt(0, totalLines-approvalPreviewPageLines)
	m.ApprovalPreviewOffset = clampInt(m.ApprovalPreviewOffset+delta, 0, maxOffset)
}

func slashHelpText() string {
	lines := make([]string, 0, len(slashCommandCatalog)+1)
	lines = append(lines, "Commands:")
	for _, command := range slashCommandCatalog {
		lines = append(lines, fmt.Sprintf("%s - %s", command.Command, command.Description))
	}
	return strings.Join(lines, "\n")
}

func slashInsertValue(command string) string {
	switch command {
	case "/provider <url>":
		return "/provider "
	case "/provider type <openai-compatible|openai-responses|gemini|anthropic> [url]":
		return "/provider type "
	case "/provider type clear [url]":
		return "/provider type clear "
	case "/provider profile <openai|gemini|anthropic|custom> [url]":
		return "/provider profile "
	case "/provider profile clear [url]":
		return "/provider profile clear "
	case "/provider format <openai_chat|openai_responses|anthropic_messages|gemini_generate_content> [url]":
		return "/provider format "
	case "/provider format clear [url]":
		return "/provider format clear "
	case "/provider endpoint <responses|chat_completions|models|anthropic_messages|gemini_generate_content> <path|url> [provider]":
		return "/provider endpoint "
	case "/provider endpoint clear <kind> [provider]":
		return "/provider endpoint clear "
	case "/provider name <display_name>":
		return "/provider name "
	case "/provider name clear [url]":
		return "/provider name clear "
	case "/model <name>":
		return "/model "
	case "/model custom <id>":
		return "/model custom "
	case "/system <text>":
		return "/system "
	case "/resume <id>", "/load <id>":
		return "/resume "
	case "/plan create <task>":
		return "/plan create "
	case "/plan revise <instruction>":
		return "/plan revise "
	case "/plan summary <text>":
		return "/plan summary "
	case "/plan objective <text>":
		return "/plan objective "
	case "/plan add <title> [:: details]":
		return "/plan add "
	case "/plan update <step> <title> [:: details]":
		return "/plan update "
	case "/plan remove <step>":
		return "/plan remove "
	case "/plan status <step> <pending|in_progress|completed|blocked>":
		return "/plan status "
	case "/plan accept [notes]":
		return "/plan accept "
	case "/search-session <query>":
		return "/search-session "
	case "/search-session #<tag> [query]":
		return "/search-session #"
	case "/tag add <tag>":
		return "/tag add "
	case "/tag remove <tag>":
		return "/tag remove "
	case "/pin <note>":
		return "/pin "
	case "/unpin <index>":
		return "/unpin "
	case "/skills enable <id>":
		return "/skills enable "
	case "/skills disable <id>":
		return "/skills disable "
	case "/skills create <task>":
		return "/skills create "
	case "/skills remove <id>":
		return "/skills remove "
	case "/skills use <id>":
		return "/skills use "
	case "/skills show <id>":
		return "/skills show "
	case "/extensions show <id|skill:<id>|mcp:<id>>":
		return "/extensions show "
	case "/extensions resolve <query>":
		return "/extensions resolve "
	case "/extensions enable <id|skill:<id>|mcp:<id>>":
		return "/extensions enable "
	case "/extensions disable <id|skill:<id>|mcp:<id>>":
		return "/extensions disable "
	case "/extensions exposure <hidden|hinted|scoped|full> <id|skill:<id>|mcp:<id>>":
		return "/extensions exposure "
	case "/mcp server <id>":
		return "/mcp server "
	case "/mcp tools <server>":
		return "/mcp tools "
	case "/mcp add stdio <id> <command...>":
		return "/mcp add stdio "
	case "/mcp add http <id> <url>":
		return "/mcp add http "
	case "/mcp add filesystem <id> [workspace]":
		return "/mcp add filesystem "
	case "/mcp lsp list [filesystem-server]":
		return "/mcp lsp list "
	case "/mcp lsp add <filesystem-server> <preset>|<lsp-id> ...":
		return "/mcp lsp add "
	case "/mcp lsp remove <filesystem-server> <lsp-id>":
		return "/mcp lsp remove "
	case "/mcp lsp doctor <filesystem-server> <path> [--lsp <lsp-id>]":
		return "/mcp lsp doctor "
	case "/mcp remove <id>":
		return "/mcp remove "
	case "/mcp enable <id>":
		return "/mcp enable "
	case "/mcp disable <id>":
		return "/mcp disable "
	case "/review <id>":
		return "/review "
	case "/approve [id]":
		return "/approve "
	case "/reject [id]":
		return "/reject "
	default:
		return command
	}
}

func slashArgumentHint(command string) string {
	trimmed := strings.TrimSpace(command)
	if trimmed == "" {
		return ""
	}
	fields := strings.Fields(trimmed)
	if len(fields) <= 1 {
		return ""
	}
	return strings.Join(fields[1:], " ")
}

func compactSlashCommand(command string) string {
	compact := strings.ToLower(command)
	if index := strings.Index(compact, " <"); index >= 0 {
		compact = compact[:index]
	}
	if index := strings.Index(compact, " ["); index >= 0 {
		compact = compact[:index]
	}
	return compact
}

func applySlashCompletion(input string) (string, bool) {
	trimmed := strings.TrimSpace(input)
	if !strings.HasPrefix(trimmed, "/") {
		return input, false
	}
	matches := suggestSlashCommands(trimmed, 1)
	if len(matches) == 0 {
		return input, false
	}
	best := matches[0]
	insertValue := best.InsertValue
	if insertValue == "" {
		insertValue = best.Command
	}
	if trimmed == insertValue || trimmed == best.Command {
		return input, false
	}
	return insertValue, true
}

func extensionExposureModes() []slashCommandSpec {
	return []slashCommandSpec{
		{Command: "hidden", Description: "hide from auto-selection and explicit surfacing", InsertValue: "hidden "},
		{Command: "hinted", Description: "available only through explicit mention or direct enablement", InsertValue: "hinted "},
		{Command: "scoped", Description: "eligible for query-scoped selection when it matches", InsertValue: "scoped "},
		{Command: "full", Description: "always visible to the runtime selection layer", InsertValue: "full "},
	}
}

func providerEndpointKindModes() []slashCommandSpec {
	return []slashCommandSpec{
		{Command: "responses", Description: "OpenAI Responses stream endpoint", InsertValue: "responses "},
		{Command: "chat_completions", Description: "OpenAI chat/completions stream endpoint", InsertValue: "chat_completions "},
		{Command: "models", Description: "model catalog fetch endpoint", InsertValue: "models "},
		{Command: "anthropic_messages", Description: "Anthropic native /messages stream endpoint", InsertValue: "anthropic_messages "},
		{Command: "gemini_generate_content", Description: "Gemini native generateContent SSE endpoint", InsertValue: "gemini_generate_content "},
	}
}

func providerTypeModes() []slashCommandSpec {
	return []slashCommandSpec{
		{Command: "openai-compatible", Description: "OpenAI-compatible chat/completions provider", InsertValue: "openai-compatible "},
		{Command: "openai-responses", Description: "OpenAI Responses API provider", InsertValue: "openai-responses "},
		{Command: "gemini", Description: "Google Gemini provider", InsertValue: "gemini "},
		{Command: "anthropic", Description: "Anthropic native provider", InsertValue: "anthropic "},
	}
}

func scoreSlashCandidate(query string, candidate string) int {
	if query == "" {
		return 100
	}
	switch {
	case candidate == query:
		return 1000
	case strings.HasPrefix(candidate, query):
		return 800
	case strings.Contains(candidate, query):
		return 300
	default:
		return -1
	}
}

func limitSlashSpecs(items []slashCommandSpec, limit int) []slashCommandSpec {
	if len(items) == 0 || limit <= 0 {
		return nil
	}
	if len(items) <= limit {
		return items
	}
	return items[:limit]
}

func (m *Model) extensionTargetSuggestions(prefix string, rawQuery string, limit int) []slashCommandSpec {
	query := strings.TrimSpace(strings.ToLower(rawQuery))
	type scored struct {
		item  slashCommandSpec
		score int
	}
	results := make([]scored, 0, len(m.ManagedSkills)+len(m.ManagedMcpServers))

	for _, skill := range m.ManagedSkills {
		command := fmt.Sprintf("skill:%s", skill.ID)
		score := scoreSlashCandidate(query, strings.ToLower(command))
		if labelScore := scoreSlashCandidate(query, strings.ToLower(skill.Label)); labelScore > score {
			score = labelScore - 50
		}
		if score < 0 && query != "" {
			continue
		}
		results = append(results, scored{
			item: slashCommandSpec{
				Command:     command,
				Description: fmt.Sprintf("skill  %s  |  exposure %s  |  scope %s", skill.Label, skill.Exposure, skill.Source),
				InsertValue: prefix + command,
			},
			score: score,
		})
	}

	for _, server := range m.ManagedMcpServers {
		command := fmt.Sprintf("mcp:%s", server.ID)
		score := scoreSlashCandidate(query, strings.ToLower(command))
		if labelScore := scoreSlashCandidate(query, strings.ToLower(server.Label)); labelScore > score {
			score = labelScore - 50
		}
		if score < 0 && query != "" {
			continue
		}
		trust := "untrusted"
		if server.Trusted {
			trust = "trusted"
		}
		results = append(results, scored{
			item: slashCommandSpec{
				Command:     command,
				Description: fmt.Sprintf("mcp  %s  |  exposure %s  |  scope %s  |  %s", server.Label, server.Exposure, server.Scope, trust),
				InsertValue: prefix + command,
			},
			score: score,
		})
	}

	sort.SliceStable(results, func(i, j int) bool {
		return results[i].score > results[j].score
	})

	items := make([]slashCommandSpec, 0, minInt(limit, len(results)))
	for _, item := range results {
		items = append(items, item.item)
		if len(items) == limit {
			break
		}
	}
	return items
}

func providerEndpointKindSuggestions(prefix string, rawQuery string, limit int) []slashCommandSpec {
	query := strings.TrimSpace(strings.ToLower(rawQuery))
	type scored struct {
		item  slashCommandSpec
		score int
	}
	results := make([]scored, 0, 5)
	for _, mode := range providerEndpointKindModes() {
		score := scoreSlashCandidate(query, strings.ToLower(mode.Command))
		if score < 0 && query != "" {
			continue
		}
		mode.InsertValue = prefix + mode.InsertValue
		results = append(results, scored{item: mode, score: score})
	}

	sort.SliceStable(results, func(i, j int) bool {
		return results[i].score > results[j].score
	})

	items := make([]slashCommandSpec, 0, minInt(limit, len(results)))
	for _, item := range results {
		items = append(items, item.item)
		if len(items) == limit {
			break
		}
	}
	return items
}

func providerTypeSuggestions(prefix string, rawQuery string, limit int) []slashCommandSpec {
	query := strings.TrimSpace(strings.ToLower(rawQuery))
	type scored struct {
		item  slashCommandSpec
		score int
	}
	results := make([]scored, 0, 4)
	for _, mode := range providerTypeModes() {
		score := scoreSlashCandidate(query, strings.ToLower(mode.Command))
		if score < 0 && query != "" {
			continue
		}
		mode.InsertValue = prefix + mode.InsertValue
		results = append(results, scored{item: mode, score: score})
	}

	sort.SliceStable(results, func(i, j int) bool {
		return results[i].score > results[j].score
	})

	items := make([]slashCommandSpec, 0, minInt(limit, len(results)))
	for _, item := range results {
		items = append(items, item.item)
		if len(items) == limit {
			break
		}
	}
	return items
}

func (m *Model) dynamicSlashSuggestions(input string, limit int) []slashCommandSpec {
	normalized := strings.ToLower(strings.TrimLeftFunc(input, unicode.IsSpace))
	trimmed := strings.TrimSpace(normalized)
	switch {
	case trimmed == "/extensions show" || strings.HasPrefix(trimmed, "/extensions show "):
		query := strings.TrimSpace(strings.TrimPrefix(trimmed, "/extensions show"))
		return m.extensionTargetSuggestions("/extensions show ", query, limit)
	case trimmed == "/extensions enable" || strings.HasPrefix(trimmed, "/extensions enable "):
		query := strings.TrimSpace(strings.TrimPrefix(trimmed, "/extensions enable"))
		return m.extensionTargetSuggestions("/extensions enable ", query, limit)
	case trimmed == "/extensions disable" || strings.HasPrefix(trimmed, "/extensions disable "):
		query := strings.TrimSpace(strings.TrimPrefix(trimmed, "/extensions disable"))
		return m.extensionTargetSuggestions("/extensions disable ", query, limit)
	case trimmed == "/extensions exposure" || strings.HasPrefix(trimmed, "/extensions exposure "):
		rest := strings.TrimSpace(strings.TrimPrefix(normalized, "/extensions exposure"))
		if rest == "" {
			modes := extensionExposureModes()
			for index := range modes {
				modes[index].InsertValue = "/extensions exposure " + modes[index].InsertValue
			}
			return limitSlashSpecs(modes, limit)
		}

		fields := strings.Fields(rest)
		if len(fields) == 1 && !strings.HasSuffix(normalized, " ") {
			query := fields[0]
			filtered := make([]slashCommandSpec, 0, 4)
			for _, mode := range extensionExposureModes() {
				if scoreSlashCandidate(query, strings.ToLower(mode.Command)) < 0 {
					continue
				}
				mode.InsertValue = "/extensions exposure " + mode.InsertValue
				filtered = append(filtered, mode)
			}
			return limitSlashSpecs(filtered, limit)
		}

		mode := fields[0]
		targetQuery := ""
		if len(fields) > 1 {
			targetQuery = strings.Join(fields[1:], " ")
		}
		validMode := false
		for _, candidate := range extensionExposureModes() {
			if candidate.Command == mode {
				validMode = true
				break
			}
		}
		if !validMode {
			return nil
		}
		return m.extensionTargetSuggestions("/extensions exposure "+mode+" ", targetQuery, limit)
	case trimmed == "/provider type" || strings.HasPrefix(trimmed, "/provider type "):
		rest := strings.TrimSpace(strings.TrimPrefix(normalized, "/provider type"))
		if rest == "" {
			return providerTypeSuggestions("/provider type ", "", limit)
		}
		fields := strings.Fields(rest)
		if len(fields) == 1 && !strings.HasSuffix(normalized, " ") {
			return providerTypeSuggestions("/provider type ", fields[0], limit)
		}
		return nil
	case trimmed == "/provider endpoint clear" || strings.HasPrefix(trimmed, "/provider endpoint clear "):
		rest := strings.TrimSpace(strings.TrimPrefix(normalized, "/provider endpoint clear"))
		if rest == "" {
			return providerEndpointKindSuggestions("/provider endpoint clear ", "", limit)
		}
		fields := strings.Fields(rest)
		if len(fields) == 1 && !strings.HasSuffix(normalized, " ") {
			return providerEndpointKindSuggestions("/provider endpoint clear ", fields[0], limit)
		}
		return nil
	case trimmed == "/provider endpoint" || strings.HasPrefix(trimmed, "/provider endpoint "):
		rest := strings.TrimSpace(strings.TrimPrefix(normalized, "/provider endpoint"))
		if rest == "" {
			return providerEndpointKindSuggestions("/provider endpoint ", "", limit)
		}
		fields := strings.Fields(rest)
		if len(fields) == 1 && !strings.HasSuffix(normalized, " ") {
			return providerEndpointKindSuggestions("/provider endpoint ", fields[0], limit)
		}
		return nil
	}
	return nil
}

func (m *Model) composerSlashSuggestions(limit int) []slashCommandSpec {
	if dynamic := m.dynamicSlashSuggestions(string(m.Input), limit); len(dynamic) > 0 {
		return dynamic
	}
	return suggestSlashCommands(string(m.Input), limit)
}

func (m *Model) composerSlashSuggestionsForDisplay(limit int) []slashCommandSpec {
	if limit <= 0 {
		return nil
	}

	trimmed := strings.TrimSpace(string(m.Input))
	if !strings.HasPrefix(trimmed, "/") {
		return nil
	}

	raw := m.composerSlashSuggestions(maxInt(limit*2, limit+2))
	display := collapseSlashSuggestionsForDisplay(raw, limit)
	if len(display) >= limit {
		return display[:limit]
	}
	if len(display) > 0 && !strings.HasPrefix(strings.TrimSpace(display[0].Command), "/") {
		return display
	}

	for _, command := range slashPinnedDisplayCommands {
		item, ok := findSlashCommandSpec(command)
		if !ok {
			continue
		}
		if hasSlashDisplayCommand(display, item) {
			continue
		}
		display = append(display, item)
		if len(display) == limit {
			break
		}
	}
	return display
}

func (m *Model) resetSlashSelection() {
	m.SlashSelection = -1
}

func (m *Model) moveSlashSelection(direction int) bool {
	matches := m.composerSlashSuggestionsForDisplay(slashSuggestionLimit)
	if len(matches) == 0 {
		m.resetSlashSelection()
		return false
	}

	switch {
	case m.SlashSelection < 0 && direction < 0:
		m.SlashSelection = len(matches) - 1
	case m.SlashSelection < 0:
		m.SlashSelection = 0
	case direction < 0 && m.SlashSelection > 0:
		m.SlashSelection--
	case direction > 0 && m.SlashSelection < len(matches)-1:
		m.SlashSelection++
	case direction > 0:
		m.SlashSelection = -1
	}
	return true
}

func (m *Model) selectedSlashSuggestion() (slashCommandSpec, bool) {
	matches := m.composerSlashSuggestionsForDisplay(slashSuggestionLimit)
	if len(matches) == 0 {
		return slashCommandSpec{}, false
	}

	index := m.SlashSelection
	if index < 0 || index >= len(matches) {
		return slashCommandSpec{}, false
	}
	return matches[index], true
}

func (m *Model) applySelectedSlashCompletion() bool {
	item, ok := m.selectedSlashSuggestion()
	if !ok {
		return false
	}

	insertValue := item.InsertValue
	if insertValue == "" {
		insertValue = item.Command
	}
	if insertValue == "" || insertValue == string(m.Input) {
		return false
	}
	m.Input = []rune(insertValue)
	m.Cursor = len(m.Input)
	m.resetSlashSelection()
	return true
}

func (m *Model) applySlashCompletion() bool {
	if m.applySelectedSlashCompletion() {
		return true
	}

	matches := m.composerSlashSuggestions(1)
	if len(matches) == 0 {
		if completed, ok := applySlashCompletion(string(m.Input)); ok {
			m.Input = []rune(completed)
			m.Cursor = len(m.Input)
			m.resetSlashSelection()
			return true
		}
		return false
	}
	insertValue := matches[0].InsertValue
	if insertValue == "" {
		insertValue = matches[0].Command
	}
	if insertValue == "" || insertValue == string(m.Input) {
		return false
	}
	m.Input = []rune(insertValue)
	m.Cursor = len(m.Input)
	m.resetSlashSelection()
	return true
}

func suggestSlashCommands(input string, limit int) []slashCommandSpec {
	trimmed := strings.TrimSpace(strings.ToLower(input))
	if !strings.HasPrefix(trimmed, "/") {
		return nil
	}

	needle := trimmed
	if needle == "/" {
		needle = ""
	}

	type scoredCommand struct {
		item  slashCommandSpec
		score int
	}
	primaryToken := needle
	if fields := strings.Fields(needle); len(fields) > 0 {
		primaryToken = fields[0]
	}
	results := make([]scoredCommand, 0, len(slashCommandCatalog))
	for _, item := range slashCommandCatalog {
		normalized := strings.ToLower(item.Command)
		compact := compactSlashCommand(item.Command)

		score := -1
		switch {
		case needle == "":
			score = 100
		case normalized == needle:
			score = 1000
		case strings.HasPrefix(normalized, needle):
			score = 800
		case strings.HasPrefix(normalized, primaryToken):
			score = 500
		case compact != normalized && strings.HasPrefix(needle, compact):
			score = 450
		case strings.Contains(normalized, needle):
			score = 200
		}
		if score >= 0 {
			results = append(results, scoredCommand{
				item:  item,
				score: score - len([]rune(item.Command)),
			})
		}
	}

	sort.SliceStable(results, func(i, j int) bool {
		if results[i].score != results[j].score {
			return results[i].score > results[j].score
		}
		return results[i].item.Command < results[j].item.Command
	})

	if len(results) == 0 {
		return nil
	}

	suggestions := make([]slashCommandSpec, 0, minInt(limit, len(results)))
	for _, item := range results {
		suggestions = append(suggestions, item.item)
		if len(suggestions) == limit {
			break
		}
	}
	return suggestions
}

func collapseSlashSuggestionsForDisplay(items []slashCommandSpec, limit int) []slashCommandSpec {
	if len(items) == 0 || limit <= 0 {
		return nil
	}

	collapsed := make([]slashCommandSpec, 0, minInt(limit, len(items)))
	seen := map[string]struct{}{}
	for _, item := range items {
		key := strings.ToLower(strings.TrimSpace(item.Command))
		if strings.HasPrefix(key, "/") {
			key = compactSlashCommand(key)
		}
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		collapsed = append(collapsed, item)
		if len(collapsed) == limit {
			break
		}
	}
	return collapsed
}

func hasSlashDisplayCommand(items []slashCommandSpec, target slashCommandSpec) bool {
	targetKey := strings.ToLower(strings.TrimSpace(target.Command))
	if strings.HasPrefix(targetKey, "/") {
		targetKey = compactSlashCommand(targetKey)
	}
	for _, item := range items {
		key := strings.ToLower(strings.TrimSpace(item.Command))
		if strings.HasPrefix(key, "/") {
			key = compactSlashCommand(key)
		}
		if key == targetKey {
			return true
		}
	}
	return false
}

func findSlashCommandSpec(command string) (slashCommandSpec, bool) {
	for _, item := range slashCommandCatalog {
		if item.Command == command {
			return item, true
		}
	}
	return slashCommandSpec{}, false
}

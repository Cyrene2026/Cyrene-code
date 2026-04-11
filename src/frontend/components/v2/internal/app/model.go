package app

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

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
	PanelSessions  Panel = "sessions"
	PanelModels    Panel = "models"
	PanelProviders Panel = "providers"
	PanelAuth      Panel = "auth"

	ApprovalSummary ApprovalPreviewMode = "summary"
	ApprovalFull    ApprovalPreviewMode = "full"

	AuthStepProvider AuthStep = "provider"
	AuthStepAPIKey   AuthStep = "api_key"
	AuthStepModel    AuthStep = "model"
	AuthStepConfirm  AuthStep = "confirm"

	scrollStep               = 8
	sessionPanelPageSize     = 4
	modelPanelPageSize       = 4
	providerPanelPageSize    = 4
	approvalQueuePageSize    = 5
	approvalPreviewPageLines = 20
	mouseDoubleClickWindow   = 400 * time.Millisecond
)

var slashCommandCatalog = []slashCommandSpec{
	{Command: "/help", Description: "show command list"},
	{Command: "/login", Description: "open HTTP login panel"},
	{Command: "/logout", Description: "remove managed user auth and rebuild transport"},
	{Command: "/auth", Description: "show auth mode, source, and persistence target"},
	{Command: "/provider", Description: "open provider picker"},
	{Command: "/provider refresh", Description: "refresh current provider models"},
	{Command: "/provider profile list", Description: "list manual provider profile overrides"},
	{Command: "/provider profile <openai|gemini|anthropic|custom> [url]", Description: "override provider profile (custom clears override)"},
	{Command: "/provider profile clear [url]", Description: "clear manual provider profile override"},
	{Command: "/provider <url>", Description: "switch provider directly (also accepts openai/gemini/anthropic)"},
	{Command: "/model", Description: "open model picker"},
	{Command: "/model refresh", Description: "refresh available models"},
	{Command: "/model <name>", Description: "switch model directly"},
	{Command: "/system", Description: "show current system prompt"},
	{Command: "/system <text>", Description: "set system prompt for this runtime"},
	{Command: "/system reset", Description: "restore default system prompt"},
	{Command: "/state", Description: "show reducer/session state diagnostics"},
	{Command: "/sessions", Description: "open sessions panel"},
	{Command: "/resume", Description: "open session resume picker"},
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
	{Command: "/skills show <id>", Description: "show one skill details"},
	{Command: "/skills enable <id>", Description: "enable one skill in project config"},
	{Command: "/skills disable <id>", Description: "disable one skill in project config"},
	{Command: "/skills remove <id>", Description: "remove one skill via project remove_skills override"},
	{Command: "/skills use <id>", Description: "use one skill for the current session only"},
	{Command: "/skills reload", Description: "reload skills config"},
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
	{Command: "/clear", Description: "clear transcript"},
	{Command: "/quit", Description: "quit bubble tea frontend"},
}

type Message struct {
	Role string `json:"role"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

type Model struct {
	Width                  int
	Height                 int
	Status                 Status
	Items                  []Message
	LiveText               string
	Input                  []rune
	Cursor                 int
	TranscriptOffset       int
	ShouldQuit             bool
	BridgeReady            bool
	Notice                 string
	NoticeIsError          bool
	MouseCapture           bool
	transcriptCacheWidth   int
	transcriptCacheVersion int
	transcriptCacheLines   []string
	transcriptVersion      int

	ActivePanel Panel

	ApprovalIndex         int
	ApprovalPreview       ApprovalPreviewMode
	ApprovalPreviewOffset int
	SessionIndex          int
	ModelIndex            int
	ProviderIndex         int

	ActiveSessionID          string
	Sessions                 []BridgeSession
	PendingReviews           []BridgeReview
	AvailableModels          []string
	AvailableProviders       []string
	ProviderProfiles         map[string]string
	ProviderProfileSources   map[string]string
	CurrentModel             string
	CurrentProvider          string
	CurrentProviderKeySource string
	Auth                     BridgeAuthStatus
	AppRoot                  string

	AuthStep     AuthStep
	AuthProvider []rune
	AuthAPIKey   []rune
	AuthModel    []rune
	AuthCursor   int
	AuthSaving   bool
	LastClickAt  time.Time
	LastClickIdx int
	LastClickPan Panel

	bridge *bridgeClient
}

func NewModel() *Model {
	return &Model{
		Width:                  100,
		Height:                 30,
		Status:                 StatusPreparing,
		ActivePanel:            PanelNone,
		ApprovalPreview:        ApprovalFull,
		AuthStep:               AuthStepProvider,
		MouseCapture:           true,
		ProviderProfiles:       map[string]string{},
		ProviderProfileSources: map[string]string{},
		Items: []Message{{
			Role: "system",
			Kind: "system_hint",
			Text: "Starting Bubble Tea v2 bridge...",
		}},
	}
}

func (m *Model) Init() tea.Cmd {
	cmds := []tea.Cmd{startBridgeCmd()}
	if m.MouseCapture {
		cmds = append(cmds, tea.EnableMouseCellMotion)
	}
	return tea.Batch(cmds...)
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch value := msg.(type) {
	case bridgeStartedMsg:
		m.bridge = value.Client
		m.BridgeReady = false
		m.Status = StatusPreparing
		m.setNotice("Bubble Tea bridge started.", false)
		return m, tea.Batch(
			waitForBridgeEvent(m.bridge),
			sendBridgeCommand(m.bridge, bridgeCommand{Type: "init"}),
		)
	case bridgeEventMsg:
		m.handleBridgeEvent(value.Event)
		if value.Event.Type == "snapshot" && value.Event.Snapshot != nil {
			if err := syncProcessAppRoot(value.Event.Snapshot.AppRoot); err != nil {
				m.Status = StatusError
				m.setNotice(fmt.Sprintf("Failed to switch workspace: %v", err), true)
				return m, nil
			}
		}
		return m, waitForBridgeEvent(m.bridge)
	case bridgeErrorMsg:
		m.Status = StatusError
		m.AuthSaving = false
		m.setNotice(value.Message, true)
		return m, nil
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
		return m, nil
	case tea.WindowSizeMsg:
		m.Width = value.Width
		m.Height = value.Height
		m.invalidateTranscriptCache()
		m.clampTranscriptOffset()
		return m, nil
	case tea.MouseMsg:
		if value.Action != tea.MouseActionPress {
			return m, nil
		}
		switch value.Button {
		case tea.MouseButtonWheelUp:
			m.handleWheelScroll(-1)
		case tea.MouseButtonWheelDown:
			m.handleWheelScroll(1)
		case tea.MouseButtonLeft:
			return m.handleMouseLeftClick(value)
		}
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(value)
	}

	return m, nil
}

func (m *Model) handleBridgeEvent(event bridgeEvent) {
	switch event.Type {
	case "snapshot":
		if event.Snapshot == nil {
			return
		}

		m.BridgeReady = true
		m.Items = event.Snapshot.Items
		m.LiveText = event.Snapshot.LiveText
		m.PendingReviews = event.Snapshot.PendingReviews
		m.Sessions = event.Snapshot.Sessions
		m.ActiveSessionID = event.Snapshot.ActiveSessionID
		m.Status = parseStatus(event.Snapshot.Status)
		m.AvailableModels = event.Snapshot.AvailableModels
		m.AvailableProviders = event.Snapshot.AvailableProviders
		m.ProviderProfiles = event.Snapshot.ProviderProfiles
		m.ProviderProfileSources = event.Snapshot.ProviderProfileSources
		m.CurrentModel = event.Snapshot.CurrentModel
		m.CurrentProvider = event.Snapshot.CurrentProvider
		m.CurrentProviderKeySource = event.Snapshot.CurrentProviderKeySource
		m.Auth = event.Snapshot.Auth
		m.AppRoot = event.Snapshot.AppRoot
		m.invalidateTranscriptCache()
		if m.ProviderProfiles == nil {
			m.ProviderProfiles = map[string]string{}
		}
		if m.ProviderProfileSources == nil {
			m.ProviderProfileSources = map[string]string{}
		}

		m.ApprovalIndex = clampInt(m.ApprovalIndex, 0, maxInt(0, len(m.PendingReviews)-1))
		m.SessionIndex = clampInt(findSelectionIndex(m.Sessions, m.ActiveSessionID, m.SessionIndex), 0, maxInt(0, len(m.Sessions)-1))
		m.ModelIndex = clampInt(findStringIndex(m.AvailableModels, m.CurrentModel, m.ModelIndex), 0, maxInt(0, len(m.AvailableModels)-1))
		m.ProviderIndex = clampInt(findStringIndex(m.AvailableProviders, m.CurrentProvider, m.ProviderIndex), 0, maxInt(0, len(m.AvailableProviders)-1))
		m.ApprovalPreviewOffset = clampInt(m.ApprovalPreviewOffset, 0, maxInt(0, m.currentApprovalPreviewLineCount()-approvalPreviewPageLines))
		m.clampTranscriptOffset()

		if len(m.PendingReviews) == 0 && m.ActivePanel == PanelApprovals {
			m.ActivePanel = PanelNone
		}
		if m.AuthSaving {
			m.AuthSaving = false
			if m.Auth.HTTPReady {
				m.ActivePanel = PanelNone
				m.setNotice("HTTP login updated.", false)
			}
		}
		if m.Notice != "" && !m.NoticeIsError {
			m.Notice = ""
		}
	case "error":
		m.Status = StatusError
		m.AuthSaving = false
		m.setNotice(event.Message, true)
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
		if m.MouseCapture {
			m.setNotice("Mouse capture enabled. Wheel scrolls the in-app view.", false)
			return m, tea.EnableMouseCellMotion
		}
		m.setNotice("Copy mode enabled. Drag to select text; press F6 to restore in-app wheel scrolling.", false)
		return m, tea.DisableMouse
	}

	if m.ActivePanel != PanelNone {
		return m.handlePanelKey(msg)
	}
	return m.handleComposerKey(msg)
}

func (m *Model) handleComposerKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEnter:
		return m, m.submitInput()
	case tea.KeyCtrlJ:
		m.insertRunes([]rune{'\n'})
		return m, nil
	case tea.KeyBackspace:
		m.deleteBackward()
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
		m.TranscriptOffset++
		m.clampTranscriptOffset()
		return m, nil
	case tea.KeyDown:
		if m.TranscriptOffset > 0 {
			m.TranscriptOffset--
		}
		m.clampTranscriptOffset()
		return m, nil
	case tea.KeyEscape:
		m.Input = m.Input[:0]
		m.Cursor = 0
		return m, nil
	case tea.KeySpace:
		m.insertRunes([]rune{' '})
		return m, nil
	case tea.KeyRunes:
		m.insertRunes(msg.Runes)
		return m, nil
	default:
		return m, nil
	}
}

func (m *Model) handleWheelScroll(direction int) {
	switch m.ActivePanel {
	case PanelApprovals:
		m.scrollApprovalPreview(direction * scrollStep)
	case PanelSessions:
		if len(m.Sessions) > 0 {
			m.SessionIndex = cycleIndex(m.SessionIndex, len(m.Sessions), direction)
		}
	case PanelModels:
		if len(m.AvailableModels) > 0 {
			m.ModelIndex = cycleIndex(m.ModelIndex, len(m.AvailableModels), direction)
		}
	case PanelProviders:
		if len(m.AvailableProviders) > 0 {
			m.ProviderIndex = cycleIndex(m.ProviderIndex, len(m.AvailableProviders), direction)
		}
	default:
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
	contentWidth := maxInt(30, width-2)
	header := m.renderHeader(contentWidth)
	panelHeight := m.panelHeight()
	statusLine := m.renderStatusLine(contentWidth)
	composer := m.renderComposer(contentWidth)
	fixedHeight := lipgloss.Height(header) + panelHeight + lipgloss.Height(statusLine) + lipgloss.Height(composer)
	transcriptHeight := maxInt(3, height-fixedHeight-1)
	return contentWidth, transcriptHeight
}

func (m *Model) handleMouseLeftClick(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	if m.ActivePanel == PanelNone {
		return m, nil
	}

	index, ok := m.panelListIndexAtMouse(msg.Y)
	if !ok {
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

	switch m.ActivePanel {
	case PanelSessions:
		m.SessionIndex = index
		if doubleClick && index >= 0 && index < len(m.Sessions) {
			m.Status = StatusPreparing
			m.setNotice("Loading selected session...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "load_session", ID: m.Sessions[index].ID})
		}
	case PanelModels:
		m.ModelIndex = index
		if doubleClick && index >= 0 && index < len(m.AvailableModels) {
			m.Status = StatusPreparing
			m.setNotice("Switching model...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_model", Value: m.AvailableModels[index]})
		}
	case PanelProviders:
		m.ProviderIndex = index
		if doubleClick && index >= 0 && index < len(m.AvailableProviders) {
			m.Status = StatusPreparing
			m.setNotice("Switching provider...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "set_provider", Value: m.AvailableProviders[index]})
		}
	}

	return m, nil
}

func (m *Model) panelListIndexAtMouse(mouseY int) (int, bool) {
	panelTop, ok := m.activePanelTop()
	if !ok {
		return 0, false
	}
	innerY := mouseY - panelTop - 1
	if innerY < 0 {
		return 0, false
	}

	switch m.ActivePanel {
	case PanelSessions:
		return listIndexAtPanelLine(len(m.Sessions), m.SessionIndex, sessionPanelPageSize, innerY, 2)
	case PanelModels:
		return listIndexAtPanelLine(len(m.AvailableModels), m.ModelIndex, modelPanelPageSize, innerY, 2)
	case PanelProviders:
		width := maxInt(50, m.Width)
		contentWidth := maxInt(30, width-2)
		bodyWidth := framedInnerWidth(panelBoxStyle, contentWidth)
		dataStartLine := 2 + len(wrapPlainText("provider profile commands: /provider profile list | /provider profile <profile> [url]", bodyWidth))
		return listIndexAtPanelLine(len(m.AvailableProviders), m.ProviderIndex, providerPanelPageSize, innerY, dataStartLine)
	default:
		return 0, false
	}
}

func (m *Model) activePanelTop() (int, bool) {
	panelHeight := m.panelHeight()
	if panelHeight <= 0 {
		return 0, false
	}
	width := maxInt(50, m.Width)
	height := maxInt(18, m.Height)
	contentWidth := maxInt(30, width-2)
	header := m.renderHeader(contentWidth)
	statusLine := m.renderStatusLine(contentWidth)
	composer := m.renderComposer(contentWidth)
	fixedHeight := lipgloss.Height(header) + panelHeight + lipgloss.Height(statusLine) + lipgloss.Height(composer)
	transcriptHeight := maxInt(3, height-fixedHeight-1)
	return lipgloss.Height(header) + transcriptHeight, true
}

func listIndexAtPanelLine(total, selected, pageSize, innerY, dataStartLine int) (int, bool) {
	if total <= 0 || innerY < dataStartLine {
		return 0, false
	}
	row := innerY - dataStartLine
	indexInPage := row / 2
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
		m.setNotice("Panel closed.", false)
		return m, nil
	}

	switch m.ActivePanel {
	case PanelApprovals:
		return m.handleApprovalKey(msg)
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
			m.SessionIndex = movePagedSelection(m.SessionIndex, len(m.Sessions), sessionPanelPageSize, "left")
		}
		return m, nil
	case tea.KeyRight:
		if len(m.Sessions) > 0 {
			m.SessionIndex = movePagedSelection(m.SessionIndex, len(m.Sessions), sessionPanelPageSize, "right")
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
			m.ModelIndex = movePagedSelection(m.ModelIndex, len(m.AvailableModels), modelPanelPageSize, "left")
		}
		return m, nil
	case tea.KeyRight:
		if len(m.AvailableModels) > 0 {
			m.ModelIndex = movePagedSelection(m.ModelIndex, len(m.AvailableModels), modelPanelPageSize, "right")
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
		if strings.ToLower(string(msg.Runes)) == "r" {
			m.Status = StatusPreparing
			m.setNotice("Refreshing models...", false)
			return m, sendBridgeCommand(m.bridge, bridgeCommand{Type: "refresh_models"})
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
			m.ProviderIndex = movePagedSelection(m.ProviderIndex, len(m.AvailableProviders), providerPanelPageSize, "left")
		}
		return m, nil
	case tea.KeyRight:
		if len(m.AvailableProviders) > 0 {
			m.ProviderIndex = movePagedSelection(m.ProviderIndex, len(m.AvailableProviders), providerPanelPageSize, "right")
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
			apiKey := strings.TrimSpace(string(m.AuthAPIKey))
			model := strings.TrimSpace(string(m.AuthModel))
			if provider == "" {
				m.AuthStep = AuthStepProvider
				m.AuthCursor = len(m.AuthProvider)
				m.setNotice("Provider is required.", true)
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
				APIKey:          apiKey,
				Model:           model,
			})
		}
		m.moveAuthStep(1)
		return m, nil
	case tea.KeyBackspace:
		m.deleteAuthBackward()
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
				m.AuthStep = AuthStepAPIKey
				m.AuthCursor = len(m.AuthAPIKey)
				return m, nil
			case '3':
				m.AuthStep = AuthStepModel
				m.AuthCursor = len(m.AuthModel)
				return m, nil
			}
		}
		m.insertAuthRunes(msg.Runes)
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

	handled, cmd := m.handleSlashCommand(query)
	if handled {
		return cmd
	}
	if strings.HasPrefix(query, "/") {
		if m.bridge == nil || !m.BridgeReady {
			m.Status = StatusError
			m.setNotice("Bridge not ready yet.", true)
			return nil
		}
		m.Status = StatusPreparing
		m.setNotice("Running command...", false)
		return sendBridgeCommand(m.bridge, bridgeCommand{Type: "command", Text: query})
	}

	if m.bridge == nil || !m.BridgeReady {
		m.Status = StatusError
		m.setNotice("Bridge not ready yet.", true)
		return nil
	}

	m.Status = StatusPreparing
	m.setNotice("Submitting query...", false)
	return sendBridgeCommand(m.bridge, bridgeCommand{Type: "submit", Text: query})
}

func (m *Model) handleSlashCommand(query string) (bool, tea.Cmd) {
	switch {
	case query == "/quit" || query == "/exit":
		m.ShouldQuit = true
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
		m.Items = []Message{}
		m.LiveText = ""
		m.invalidateTranscriptCache()
		m.TranscriptOffset = 0
		m.setNotice("Transcript cleared.", false)
		return true, nil
	case query == "/new":
		m.Status = StatusPreparing
		m.setNotice("Creating a new session...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "new_session"})
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
	case strings.HasPrefix(query, "/provider profile clear"):
		tail := strings.TrimSpace(strings.TrimPrefix(query, "/provider profile clear"))
		m.Status = StatusPreparing
		m.setNotice("Clearing provider profile override...", false)
		return true, sendBridgeCommand(m.bridge, bridgeCommand{Type: "clear_provider_profile", Value: tail})
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
		m.setNotice("Login panel opened.", false)
		return true, nil
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
	steps := []AuthStep{AuthStepProvider, AuthStepAPIKey, AuthStepModel, AuthStepConfirm}
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

func (m *Model) currentAuthFieldLength() int {
	switch m.AuthStep {
	case AuthStepProvider:
		return len(m.AuthProvider)
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

func (m *Model) setNotice(text string, isError bool) {
	m.Notice = strings.TrimSpace(text)
	m.NoticeIsError = isError
}

func (m *Model) invalidateTranscriptCache() {
	m.transcriptVersion++
	m.transcriptCacheWidth = 0
	m.transcriptCacheVersion = 0
	m.transcriptCacheLines = nil
}

func (m *Model) insertRunes(values []rune) {
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
		compact := normalized
		if index := strings.Index(compact, " <"); index >= 0 {
			compact = compact[:index]
		}
		if index := strings.Index(compact, " ["); index >= 0 {
			compact = compact[:index]
		}

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

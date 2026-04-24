package app

import (
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/rivo/uniseg"
)

var (
	uiBorderMutedColor     = lipgloss.Color("#263244")
	uiBorderStrongColor    = lipgloss.Color("#3B82F6")
	uiTextPrimaryColor     = lipgloss.Color("#E6EDF3")
	uiTextSecondaryColor   = lipgloss.Color("#AAB6C3")
	uiTextMutedColor       = lipgloss.Color("#7D8590")
	uiAccentBlueColor      = lipgloss.Color("#79C0FF")
	uiAccentCyanColor      = lipgloss.Color("#56D4DD")
	uiAccentGreenColor     = lipgloss.Color("#7EE787")
	uiAccentYellowColor    = lipgloss.Color("#F2CC60")
	uiAccentOrangeColor    = lipgloss.Color("#FFA657")
	uiAccentPurpleColor    = lipgloss.Color("#D2A8FF")
	uiAccentRedColor       = lipgloss.Color("#FFA198")
	uiComposerSurfaceColor = lipgloss.Color("#161B22")
	uiPanelHeaderColor     = lipgloss.Color("#172235")
	uiPanelHeaderTextColor = lipgloss.Color("#D1E9FF")

	rootStyle = lipgloss.NewStyle()

	startupLogoTrueColorStart = rgbColor{R: 0x2F, G: 0x81, B: 0xFF}
	startupLogoTrueColorEnd   = rgbColor{R: 0xA8, G: 0x55, B: 0xF7}
	startupLogoANSI256Palette = []string{"27", "33", "39", "63", "69", "99", "129", "135"}
	startupLogoANSIPalette    = []string{"12", "12", "13", "13"}

	appShellStyle = lipgloss.NewStyle().
			Padding(0)

	frameStyle = lipgloss.NewStyle().
			Foreground(uiTextPrimaryColor).
			Padding(1, 1, 0, 1)

	activeFrameStyle = frameStyle.Copy()

	brandChipStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("11")).
			Padding(0, 1)

	titleStyle      = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#FFFFFF"))
	subtitleStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#C9D1D9"))
	minorTitleStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#8B949E"))
	dimStyle        = lipgloss.NewStyle().Foreground(lipgloss.Color("7"))
	errorStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("9")).Bold(true)
	userStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("10")).Bold(true)
	userBubbleStyle = lipgloss.NewStyle().
			Foreground(uiTextPrimaryColor).
			Background(lipgloss.Color("#1E293B")).
			ColorWhitespace(true).
			Padding(0, 1, 0, 0)
	asstStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("14")).Bold(true)
	reviewStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("11")).Bold(true)
	toolStatusStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("#8B949E"))
	systemStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("12"))
	sectionStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("13"))
	codeBlockStyle  = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#E6EDF3")).
			ColorWhitespace(true)
	codeBlockHeaderStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#D1E9FF")).
				Bold(true)
	codeBlockBorderStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#3B82F6"))
	codeBlockLineNoStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#6E7681"))
	inlineCodeStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FFFFFF")).
			Bold(true)
	codeFenceStyle      = dimStyle.Copy().Italic(true)
	codeKeywordStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#FF7B72")).Bold(true)
	codeStringStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("#A5D6FF"))
	codeCommentStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#8B949E")).Italic(true)
	codeNumberStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("#79C0FF"))
	codeTypeStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("#D2A8FF"))
	codeBuiltinStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#FFA657"))
	codePlainStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("#E6EDF3"))
	linkStyle           = lipgloss.NewStyle().Foreground(lipgloss.Color("#79C0FF")).Underline(true)
	ruleStyle           = dimStyle.Copy()
	taskDoneStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("#7EE787")).Bold(true)
	taskTodoStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("#79C0FF")).Bold(true)
	diffGutterBaseStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#24292F")).
				Background(lipgloss.Color("#FFFFFF")).
				ColorWhitespace(true)
	diffAddGutterStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#7EE787")).
				Bold(true)
	diffRemoveGutterStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#FFA198")).
				Bold(true)
	diffAddLineStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#E6EDF3")).
				Background(lipgloss.Color("#103B2A")).
				ColorWhitespace(true)
	diffRemoveLineStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#F0D7DA")).
				Background(lipgloss.Color("#5D1E27")).
				ColorWhitespace(true)
	diffHunkStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#79C0FF")).
			Bold(true)

	inputBoxStyle = lipgloss.NewStyle().
			Foreground(uiTextPrimaryColor).
			Background(uiComposerSurfaceColor).
			ColorWhitespace(true).
			Padding(0, 1)
	composerFocusAccentStyle = lipgloss.NewStyle().
					Foreground(uiAccentBlueColor).
					Bold(true)
	composerPlaceholderStyle = lipgloss.NewStyle().
					Background(uiComposerSurfaceColor).
					Foreground(uiTextMutedColor).
					Italic(true)
	composerContinuationStyle = lipgloss.NewStyle().
					Background(uiComposerSurfaceColor).
					Foreground(lipgloss.Color("#8B949E"))
	composerTextStyle = lipgloss.NewStyle().
				Background(uiComposerSurfaceColor).
				Foreground(uiTextPrimaryColor).
				ColorWhitespace(true)
	composerDividerStyle = lipgloss.NewStyle().
				Foreground(uiBorderMutedColor)
	compositionStyle = lipgloss.NewStyle().
				Background(uiComposerSurfaceColor).
				Underline(true).
				Foreground(uiAccentPurpleColor)
	composerCursorStyle = cursorStyle.Copy().
				Background(uiComposerSurfaceColor)
	attachmentChipStyle = lipgloss.NewStyle().
				Foreground(uiTextPrimaryColor).
				Background(lipgloss.Color("#1B2A44")).
				ColorWhitespace(true)
	attachmentAddStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("14")).
				Bold(true)
	collapsedPasteStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#58A6FF")).
				Background(lipgloss.Color("#17324D")).
				Bold(true)
	toolPrefixStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#8B949E")).
			Bold(true)
	toolDetailStyle = lipgloss.NewStyle().
			Foreground(uiTextSecondaryColor)
	toolErrorPrefixStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#FFA198")).
				Bold(true)
	toolChipStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#0D1117")).
			Background(lipgloss.Color("#8B949E")).
			ColorWhitespace(true).
			Bold(true).
			Padding(0, 1)
	toolDetailDimStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#8B949E"))

	focusedInputBoxStyle = inputBoxStyle.Copy()

	panelBoxStyle = lipgloss.NewStyle().
			Border(lipgloss.NormalBorder()).
			BorderForeground(uiBorderMutedColor).
			Foreground(uiTextPrimaryColor).
			Padding(0, 1)

	panelHeaderBarStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(uiPanelHeaderTextColor).
				Background(lipgloss.Color("#172235")).
				ColorWhitespace(true)

	panelSummaryStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(uiTextSecondaryColor).
				Background(lipgloss.Color("#0D1626")).
				ColorWhitespace(true)
	panelTitleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#08111F")).
			Background(uiAccentBlueColor).
			ColorWhitespace(true)
	panelTitleMutedStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#B8C4D6")).
				Background(lipgloss.Color("#172235")).
				ColorWhitespace(true)
	panelSectionStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#D1E9FF")).
				Background(lipgloss.Color("#10233A")).
				ColorWhitespace(true).
				Bold(true)
	panelErrorBannerStyle = lipgloss.NewStyle().
				Foreground(uiAccentRedColor).
				Background(lipgloss.Color("#301318")).
				ColorWhitespace(true).
				Bold(true)
	footerBarStyle = lipgloss.NewStyle().
			Foreground(uiTextSecondaryColor)
	footerStatusLabelStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#8B949E")).
				Bold(true)
	footerTokenValueStyle    = lipgloss.NewStyle().Foreground(uiAccentGreenColor).Bold(true)
	footerBranchValueStyle   = lipgloss.NewStyle().Foreground(uiAccentYellowColor)
	footerProjectValueStyle  = lipgloss.NewStyle().Foreground(uiAccentBlueColor)
	footerModelValueStyle    = lipgloss.NewStyle().Foreground(uiAccentPurpleColor)
	footerProviderValueStyle = lipgloss.NewStyle().Foreground(uiAccentCyanColor)
	footerDurationValueStyle = lipgloss.NewStyle().Foreground(uiAccentOrangeColor).Bold(true)
	footerStatusValueStyle   = lipgloss.NewStyle().Foreground(uiAccentGreenColor).Bold(true)
	footerTimeStyle          = lipgloss.NewStyle().Foreground(uiTextSecondaryColor)
	pageHeroStyle            = lipgloss.NewStyle().
					Foreground(lipgloss.Color("#D1E9FF")).
					Background(lipgloss.Color("#172235")).
					Bold(true)
	pageHintStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#8B949E"))
	pageSelectedBannerStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#0D1117")).
				Background(lipgloss.Color("#7EE787")).
				Bold(true)
	startupNameStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#D1E9FF")).
				Bold(true)
	startupTaglineStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#AAB6C3"))
	startupCommandStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#79C0FF")).
				Bold(true)
	startupHintLabelStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#8B949E")).
				Bold(true)

	cursorStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("14"))
	statusKeyStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("14"))
	statusChipBase = lipgloss.NewStyle().
			Border(lipgloss.NormalBorder()).
			Padding(0, 1)
	selectedPanelItemStyle = lipgloss.NewStyle().
				Background(lipgloss.Color("15")).
				Foreground(lipgloss.Color("0")).
				ColorWhitespace(true).
				Bold(true)
	selectedSlashStyle = lipgloss.NewStyle().
				Background(lipgloss.Color("15")).
				Foreground(lipgloss.Color("0")).
				Bold(true)
	approvalMetaKeyStyle      = dimStyle.Copy().Bold(true)
	approvalMetaValueStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#E6EDF3"))
	approvalPathStyle         = lipgloss.NewStyle().Foreground(lipgloss.Color("#79C0FF")).Bold(true)
	approvalIDStyle           = lipgloss.NewStyle().Foreground(lipgloss.Color("#8B949E")).Bold(true)
	approvalDetailStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("#AAB6C3"))
	approvalRequiredStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("#F2CC60")).Bold(true)
	approvalApprovedStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("#7EE787")).Bold(true)
	approvalRejectedStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("#FFA198")).Bold(true)
	approvalSeparatorStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#6E7681"))
	approvalDetailBannerStyle = lipgloss.NewStyle().
					Foreground(lipgloss.Color("#0D1117")).
					Background(lipgloss.Color("#E6EDF3")).
					Bold(true).
					Padding(0, 1)
	approvalSectionStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("#A5D6FF")).Bold(true)
)

var startupShadowLogoLines = []string{
	"██╗   ██████╗██╗   ██╗██████╗ ███████╗███╗   ██╗███████╗",
	"╚██╗ ██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝████╗  ██║██╔════╝",
	" ╚██╗██║      ╚████╔╝ ██████╔╝█████╗  ██╔██╗ ██║█████╗  ",
	" ██╔╝██║       ╚██╔╝  ██╔══██╗██╔══╝  ██║╚██╗██║██╔══╝  ",
	"██╔╝ ╚██████╗   ██║   ██║  ██║███████╗██║ ╚████║███████╗",
	"╚═╝   ╚═════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝╚══════╝",
}

var statusSpinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

var (
	diffPattern                  = regexp.MustCompile(`^([+-])\s*(\d+)?\s*\|\s?(.*)$`)
	maskedDiffPattern            = regexp.MustCompile(`^([+-])\s*(\*{3,}.*)$`)
	numberedDiffPattern          = regexp.MustCompile(`^\s*(\d+)\s*\|\s?(.*)$`)
	diffStatsPattern             = regexp.MustCompile(`^\s*(?:diff_stats|diff):\s*(\+\d+)\s+(-\d+)\s*$`)
	diffPreviewOmittedPattern    = regexp.MustCompile(`^\s*diff_preview_omitted:\s*(\d+)\s*$`)
	fileMutationToolLinePattern  = regexp.MustCompile(`^Tool:\s+(create_file|write_file|edit_file|apply_patch)\s+(.+?)(?:\s+\|\s+.*)?$`)
	fileMutationReceiptPattern   = regexp.MustCompile(`^(?:Created|Wrote|Edited|Patched) file:\s+(.+)$`)
	confirmedMutationLinePattern = regexp.MustCompile(`^\[confirmed file mutation\]\s+(create_file|write_file|edit_file|apply_patch)\s+(.+)$`)
	leakedToolActionJSONPattern  = regexp.MustCompile(`"action"\s*:\s*"(read_file|read_files|read_range|read_json|read_yaml|list_dir|create_dir|create_file|write_file|edit_file|apply_patch|applypatch|delete_file|stat_path|stat_paths|outline_file|find_files|find_symbol|find_references|search_text|search_text_context|copy_path|move_path|git_status|git_diff|git_log|git_show|git_blame|ts_hover|ts_definition|ts_references|ts_diagnostics|ts_prepare_rename|lsp_hover|lsp_definition|lsp_implementation|lsp_type_definition|lsp_references|lsp_workspace_symbols|lsp_document_symbols|lsp_diagnostics|lsp_prepare_rename|lsp_rename|lsp_code_actions|lsp_format_document|run_command|run_shell|open_shell|write_shell|read_shell|shell_status|interrupt_shell|close_shell)"`)
	leakedFunctionCallPattern    = regexp.MustCompile(`(?:to=functions\.[a-z_]+|recipient_name"\s*:\s*"functions\.[a-z_]+")`)
	orderedListPattern           = regexp.MustCompile(`^([ \t]*)(\d+)[.)]\s+(.*)$`)
	unorderedListPattern         = regexp.MustCompile(`^([ \t]*)([-*+])\s+(.*)$`)
	taskListPattern              = regexp.MustCompile(`^\[( |x|X)\]\s+(.*)$`)
	markdownRulePattern          = regexp.MustCompile(`^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$`)
	setextHeadingPattern         = regexp.MustCompile(`^\s{0,3}(=+|-+)\s*$`)
	kvPattern                    = regexp.MustCompile(`^([a-z][a-z0-9_ ]*):\s*(.*)$`)
	headerKVPattern              = regexp.MustCompile(`^[a-z_]+=.*$`)
	composerPasteSummaryPattern  = regexp.MustCompile(`\[chars \d+ \| \d+ bytes\]`)
)

const (
	toolStatusANSIStart                     = "\x1b[38;2;139;148;158m"
	toolStatusExploreANSIStart              = "\x1b[38;2;227;179;65m"
	toolStatusReadANSIStart                 = "\x1b[38;2;88;166;255m"
	toolStatusSemanticANSIStart             = "\x1b[38;2;94;215;200m"
	toolStatusMutationANSIStart             = "\x1b[38;2;126;231;135m"
	toolStatusGitANSIStart                  = "\x1b[38;2;255;166;87m"
	toolStatusShellANSIStart                = "\x1b[38;2;238;196;91m"
	toolStatusANSIEnd                       = "\x1b[0m"
	diffAddSignANSI                         = "\x1b[38;2;126;231;135m"
	diffRemoveSignANSI                      = "\x1b[38;2;255;161;152m"
	diffAddANSIStart                        = "\x1b[38;2;126;231;135;48;2;16;63;43m"
	diffRemoveANSIStart                     = "\x1b[38;2;255;161;152;48;2;93;30;39m"
	diffANSIEnd                             = "\x1b[0m"
	composerFocusRailGlyph                  = "┃"
	composerMinInputRows                    = 3
	composerVisibleRowLimit                 = 6
	composerCollapsedPasteCharThreshold     = 280
	composerCollapsedPasteTailChars         = 96
	composerCollapsedPasteMinCollapsedChars = 120
	modelCustomHint                         = "custom: press c or type /model custom <id>"
)

var canonicalToolStatusActionLookup = buildCanonicalToolStatusActionLookup([]string{
	"list_dir",
	"create_dir",
	"stat_path",
	"stat_paths",
	"find_files",
	"copy_path",
	"move_path",
	"read_file",
	"read_files",
	"read_range",
	"read_json",
	"read_yaml",
	"outline_file",
	"find_symbol",
	"find_references",
	"search_text",
	"search_text_context",
	"create_file",
	"write_file",
	"edit_file",
	"apply_patch",
	"delete_file",
	"git_status",
	"git_diff",
	"git_log",
	"git_show",
	"git_blame",
	"ts_hover",
	"ts_definition",
	"ts_references",
	"ts_diagnostics",
	"ts_prepare_rename",
	"lsp_hover",
	"lsp_definition",
	"lsp_implementation",
	"lsp_type_definition",
	"lsp_references",
	"lsp_workspace_symbols",
	"lsp_document_symbols",
	"lsp_diagnostics",
	"lsp_prepare_rename",
	"lsp_rename",
	"lsp_code_actions",
	"lsp_format_document",
	"run_command",
	"run_shell",
	"open_shell",
	"write_shell",
	"read_shell",
	"shell_status",
	"interrupt_shell",
	"close_shell",
})

func (m *Model) View() string {
	width := maxInt(50, m.Width)
	height := maxInt(18, m.Height)
	contentWidth := maxInt(30, framedInnerWidth(appShellStyle, width))
	contentHeight := maxInt(12, framedInnerHeight(appShellStyle, height))

	header := m.renderTopStatusBar(contentWidth)
	composer := ""
	topComposerDivider := ""
	bottomComposerDivider := ""
	if !m.shouldHideComposerForPanel() {
		composer = m.renderComposer(contentWidth)
		topComposerDivider = renderComposerTopDivider(contentWidth)
		bottomComposerDivider = renderComposerBottomDivider(contentWidth)
	}
	footer := m.renderBottomStatusBar(contentWidth)
	fixedHeight := lipgloss.Height(header) +
		lipgloss.Height(composer) +
		lipgloss.Height(topComposerDivider) +
		lipgloss.Height(bottomComposerDivider) +
		lipgloss.Height(footer)
	bodyHeight := maxInt(5, contentHeight-fixedHeight)
	body := m.renderMainArea(contentWidth, bodyHeight)
	if composer == "" {
		m.setTerminalCursorAnchor(TerminalCursorAnchor{})
	} else {
		m.updateTerminalCursorAnchor(contentWidth, lipgloss.Height(composer), lipgloss.Height(bottomComposerDivider), lipgloss.Height(footer))
	}

	parts := []string{
		header,
		body,
		topComposerDivider,
		composer,
		bottomComposerDivider,
		footer,
	}
	content := joinNonEmptyLines(parts...)
	rendered := rootStyle.Width(width).Height(height).Render(
		appShellStyle.Width(contentWidth).Render(content),
	)
	return truncateMultilineDisplayWidth(rendered, width)
}

func (m *Model) renderMainArea(width, height int) string {
	contentHeight := maxInt(1, height)

	if m.ActivePanel == PanelNone {
		return m.renderSessionPane(width, contentHeight, true)
	}

	if usesPagePanelLayout(m.ActivePanel) {
		return m.renderActivePanel(width, contentHeight)
	}

	if width >= 96 {
		panelWidth := m.widePanelWidth(width)
		sessionWidth := maxInt(24, width-panelWidth-1)
		return lipgloss.JoinHorizontal(
			lipgloss.Top,
			m.renderSessionPane(sessionWidth, contentHeight, false),
			" ",
			m.renderActivePanel(panelWidth, contentHeight),
		)
	}

	panelHeight := clampInt(contentHeight/2, 10, 16)
	sessionHeight := maxInt(4, contentHeight-panelHeight-1)
	return lipgloss.JoinVertical(
		lipgloss.Left,
		m.renderSessionPane(width, sessionHeight, false),
		m.renderActivePanel(width, panelHeight),
	)
}

func (m *Model) widePanelWidth(totalWidth int) int {
	if totalWidth <= 0 {
		return 34
	}

	minPanelWidth := 40
	minSessionWidth := 52
	desiredWidth := totalWidth * 3 / 8

	if m.ActivePanel == PanelApprovals {
		minPanelWidth = 44
		desiredWidth = totalWidth * 2 / 5
	} else if m.ActivePanel == PanelPlans {
		minPanelWidth = 46
		desiredWidth = totalWidth * 2 / 5
	} else if m.ActivePanel == PanelProviders {
		minPanelWidth = 50
		desiredWidth = totalWidth / 2
	}

	maxPanelWidth := totalWidth - minSessionWidth - 1
	if maxPanelWidth < minPanelWidth {
		return clampInt(totalWidth/3, 34, maxInt(34, totalWidth-25))
	}

	upperBound := 68
	if m.ActivePanel == PanelApprovals {
		upperBound = 76
	} else if m.ActivePanel == PanelPlans {
		upperBound = 78
	}
	return clampInt(desiredWidth, minPanelWidth, minInt(upperBound, maxPanelWidth))
}

func (m *Model) renderTopStatusBar(width int) string {
	return ""
}

func (m *Model) renderBottomStatusBar(width int) string {
	now := m.statusClockNow()
	items := []footerStatusItem{
		{Label: "TOKENS", Value: formatUsageCompact(m.UsageSummary.TotalTokens), ValueStyle: footerTokenValueStyle, Priority: 10},
		{Label: "CACHE", Value: formatUsageCompact(m.UsageSummary.CachedTokens), ValueStyle: footerTokenValueStyle, Priority: 20},
		{Label: "MODEL", Value: emptyFallback(m.CurrentModel, "none"), ValueStyle: footerModelValueStyle, Priority: 30},
		{Label: "PROVIDER", Value: m.providerDisplayName(m.CurrentProvider), ValueStyle: footerProviderValueStyle, Priority: 40},
		{Label: "STATUS", Value: m.renderAnimatedStatusLabel(), ValueStyle: footerStatusValueStyle, Priority: 50},
		{Label: "TIME", Value: m.renderRequestElapsedLabel(now), ValueStyle: footerDurationValueStyle, Priority: 60},
		{Label: "BRANCH", Value: emptyFallback(m.GitBranch, "none"), ValueStyle: footerBranchValueStyle, Priority: 70},
		{Label: "PROJECT", Value: formatProjectPathLabel(m.AppRoot, maxInt(12, width/8)), ValueStyle: footerProjectValueStyle, Priority: 80},
	}
	return footerBarStyle.Width(width).MaxWidth(width).Render(
		renderSegmentedStatusBar(width, items, now.Format("2006-01-02 15:04:05")),
	)
}

func (m *Model) renderRequestElapsedLabel(now time.Time) string {
	hasTiming := m.RequestTimingActive || !m.RequestTimingStartedAt.IsZero() || m.RequestTimingElapsedMs > 0
	if !hasTiming {
		return "-"
	}
	elapsedMs := m.RequestTimingElapsedMs
	if m.RequestTimingActive && !m.RequestTimingSyncedAt.IsZero() {
		activeElapsedMs := m.RequestTimingBaseElapsed + now.Sub(m.RequestTimingSyncedAt).Milliseconds()
		if activeElapsedMs > elapsedMs {
			elapsedMs = activeElapsedMs
		}
	} else if m.RequestTimingActive && !m.RequestTimingStartedAt.IsZero() {
		activeElapsedMs := now.Sub(m.RequestTimingStartedAt).Milliseconds()
		if activeElapsedMs > elapsedMs {
			elapsedMs = activeElapsedMs
		}
	}
	return formatRequestElapsed(elapsedMs)
}

func (m *Model) renderAnimatedStatusLabel() string {
	label := strings.ToUpper(string(statusLabel(m.Status)))
	if !m.isAnimatingStatus() || len(statusSpinnerFrames) == 0 {
		return label
	}
	return statusSpinnerFrames[m.SpinnerFrame%len(statusSpinnerFrames)] + " " + label
}

type statusColumn struct {
	Label string
	Value string
	Color lipgloss.Color
}

type footerStatusItem struct {
	Label      string
	Value      string
	ValueStyle lipgloss.Style
	Priority   int
}

type rgbColor struct {
	R int
	G int
	B int
}

func (c rgbColor) hex() string {
	return fmt.Sprintf("#%02X%02X%02X", clampInt(c.R, 0, 255), clampInt(c.G, 0, 255), clampInt(c.B, 0, 255))
}

func interpolateRGB(start, end rgbColor, step, maxStep int) rgbColor {
	if maxStep <= 0 {
		return start
	}
	return rgbColor{
		R: start.R + ((end.R-start.R)*step)/maxStep,
		G: start.G + ((end.G-start.G)*step)/maxStep,
		B: start.B + ((end.B-start.B)*step)/maxStep,
	}
}

func startupLogoDiagonalStep(row, col, rowCount, colCount int) (int, int) {
	maxRow := maxInt(1, rowCount-1)
	maxCol := maxInt(1, colCount-1)
	rowStep := clampInt(row, 0, maxRow) * 1024 / maxRow
	colStep := clampInt(col, 0, maxCol) * 1024 / maxCol
	return rowStep + colStep, 2048
}

func startupLogoPaletteIndex(step, maxStep, paletteLen int) int {
	if paletteLen <= 1 || maxStep <= 0 {
		return 0
	}
	return clampInt((step*(paletteLen-1))/maxStep, 0, paletteLen-1)
}

func startupLogoColorAt(row, col, rowCount, colCount int) lipgloss.CompleteColor {
	step, maxStep := startupLogoDiagonalStep(row, col, rowCount, colCount)
	trueColor := interpolateRGB(startupLogoTrueColorStart, startupLogoTrueColorEnd, step, maxStep).hex()
	ansi256 := startupLogoANSI256Palette[startupLogoPaletteIndex(step, maxStep, len(startupLogoANSI256Palette))]
	ansi := startupLogoANSIPalette[startupLogoPaletteIndex(step, maxStep, len(startupLogoANSIPalette))]
	return lipgloss.CompleteColor{
		TrueColor: trueColor,
		ANSI256:   ansi256,
		ANSI:      ansi,
	}
}

func renderGradientLogoLine(value string, rowIndex, rowCount, colCount int) string {
	runes := []rune(value)
	if len(runes) == 0 {
		return ""
	}

	var builder strings.Builder
	for index, r := range runes {
		if r == ' ' {
			builder.WriteRune(r)
			continue
		}
		colIndex := clampInt(index, 0, maxInt(0, colCount-1))
		builder.WriteString(lipgloss.NewStyle().Bold(true).Foreground(startupLogoColorAt(rowIndex, colIndex, rowCount, colCount)).Render(string(r)))
	}
	return builder.String()
}

func startupLogoLinesForWidth(width int) ([]string, int) {
	lines := make([]string, 0, len(startupShadowLogoLines))
	maxWidth := 0
	for _, line := range startupShadowLogoLines {
		truncated := truncatePlain(line, width)
		lines = append(lines, truncated)
		maxWidth = maxInt(maxWidth, lipgloss.Width(truncated))
	}
	return lines, maxWidth
}

func fitToWidth(value string, width int) string {
	return lipgloss.NewStyle().MaxWidth(width).Render(value)
}

func statusValueWidth(totalWidth, columnCount int, label string) int {
	if totalWidth <= 0 || columnCount <= 0 {
		return 1
	}
	cellWidth := maxInt(1, totalWidth/columnCount)
	return maxInt(1, cellWidth-lipgloss.Width(strings.TrimSpace(label))-1)
}

func renderStatusColumns(width int, columns ...statusColumn) string {
	if len(columns) == 0 || width <= 0 {
		return ""
	}
	baseWidth := width / len(columns)
	remainder := width % len(columns)
	rendered := make([]string, 0, len(columns))
	for index, column := range columns {
		cellWidth := baseWidth
		if index < remainder {
			cellWidth++
		}
		text := truncatePlain(
			fmt.Sprintf("%s %s", strings.ToUpper(strings.TrimSpace(column.Label)), emptyFallback(strings.TrimSpace(column.Value), "none")),
			maxInt(1, cellWidth),
		)
		rendered = append(rendered, lipgloss.NewStyle().
			Width(cellWidth).
			MaxWidth(cellWidth).
			Align(lipgloss.Center).
			Background(column.Color).
			Foreground(lipgloss.Color("0")).
			Bold(true).
			Render(text))
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, rendered...)
}

func renderCompactStatusBar(width int, left, right string, color lipgloss.Color) string {
	if width <= 0 {
		return ""
	}
	right = strings.TrimSpace(right)
	if right == "" {
		return lipgloss.NewStyle().
			Width(width).
			MaxWidth(width).
			Align(lipgloss.Left).
			Background(color).
			Foreground(lipgloss.Color("0")).
			Bold(true).
			Render(truncatePlain(strings.TrimSpace(left), width))
	}
	rightWidth := lipgloss.Width(right)
	if rightWidth >= width {
		return lipgloss.NewStyle().
			Width(width).
			MaxWidth(width).
			Align(lipgloss.Left).
			Background(color).
			Foreground(lipgloss.Color("0")).
			Bold(true).
			Render(truncatePlain(right, width))
	}

	leftWidth := maxInt(1, width-rightWidth-1)
	leftText := truncatePlain(strings.TrimSpace(left), leftWidth)
	leftCell := lipgloss.NewStyle().
		Width(leftWidth).
		MaxWidth(leftWidth).
		Align(lipgloss.Left).
		Background(color).
		Foreground(lipgloss.Color("0")).
		Bold(true).
		Render(leftText)
	rightCell := lipgloss.NewStyle().
		Width(width - leftWidth).
		MaxWidth(width - leftWidth).
		Align(lipgloss.Right).
		Background(color).
		Foreground(lipgloss.Color("0")).
		Bold(true).
		Render(right)
	return leftCell + rightCell
}

func renderSegmentedStatusBar(width int, items []footerStatusItem, right string) string {
	if width <= 0 {
		return ""
	}

	right = footerTimeStyle.Render(strings.TrimSpace(right))
	rightWidth := displayWidth(right)
	showClock := width >= 140 && rightWidth < width
	if !showClock {
		right = ""
		rightWidth = 0
	}

	gapWidth := footerRightGap(width)
	if rightWidth == 0 {
		gapWidth = 0
	}
	leftWidth := maxInt(1, width-rightWidth-gapWidth)
	items = footerItemsForWidth(items, leftWidth)
	left := renderFooterStatusItems(items, footerStatusGap(width))
	left = truncateDisplayWidth(left, leftWidth, "~")
	padding := strings.Repeat(" ", maxInt(gapWidth, width-displayWidth(left)-rightWidth))
	return left + padding + right
}

func footerItemsForWidth(items []footerStatusItem, width int) []footerStatusItem {
	filtered := make([]footerStatusItem, 0, len(items))
	for _, item := range items {
		if strings.TrimSpace(item.Label) == "" || strings.TrimSpace(item.Value) == "" {
			continue
		}
		filtered = append(filtered, item)
	}
	for len(filtered) > 1 && renderFooterStatusItems(filtered, footerStatusGap(width)) != "" && displayWidth(renderFooterStatusItems(filtered, footerStatusGap(width))) > width {
		dropIndex := -1
		dropPriority := -1
		for index, item := range filtered {
			if item.Priority > dropPriority {
				dropPriority = item.Priority
				dropIndex = index
			}
		}
		if dropIndex < 0 {
			break
		}
		filtered = append(filtered[:dropIndex], filtered[dropIndex+1:]...)
	}
	return filtered
}

func renderFooterStatusItems(items []footerStatusItem, gap string) string {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		label := strings.ToUpper(strings.TrimSpace(item.Label))
		value := strings.TrimSpace(item.Value)
		if label == "" || value == "" {
			continue
		}
		labelStyle := footerStatusLabelStyle.Copy()
		valueStyle := item.ValueStyle.Copy()
		parts = append(parts, labelStyle.Render(label)+" "+valueStyle.Render(value))
	}
	return footerBarStyle.Render(strings.Join(parts, gap))
}

func footerStatusGap(width int) string {
	switch {
	case width >= 180:
		return "    "
	case width >= 140:
		return "   "
	default:
		return "  "
	}
}

func footerRightGap(width int) int {
	if width >= 140 {
		return 4
	}
	return 2
}

func formatUsageCompact(tokens int) string {
	total := maxInt(0, tokens)
	switch {
	case total >= 1_000_000:
		return fmt.Sprintf("%.1fm", float64(total)/1_000_000)
	case total >= 1_000:
		value := float64(total) / 1_000
		if total%1_000 == 0 {
			return fmt.Sprintf("%.0fk", value)
		}
		return fmt.Sprintf("%.1fk", value)
	default:
		return fmt.Sprintf("%d", total)
	}
}

func formatRequestElapsed(elapsedMs int64) string {
	if elapsedMs < 0 {
		elapsedMs = 0
	}
	if elapsedMs < 1_000 {
		return fmt.Sprintf("%dms", elapsedMs)
	}
	if elapsedMs < 10_000 {
		return fmt.Sprintf("%.1fs", float64(elapsedMs)/1_000)
	}
	totalSeconds := elapsedMs / 1_000
	if totalSeconds < 60 {
		return fmt.Sprintf("%ds", totalSeconds)
	}
	if totalSeconds < 3_600 {
		return fmt.Sprintf("%dm%02ds", totalSeconds/60, totalSeconds%60)
	}
	return fmt.Sprintf("%dh%02dm", totalSeconds/3_600, (totalSeconds%3_600)/60)
}

func usesPagePanelLayout(panel Panel) bool {
	switch panel {
	case PanelSessions, PanelModels, PanelProviders, PanelAuth, PanelPlans:
		return true
	default:
		return false
	}
}

func (m *Model) shouldHideComposerForPanel() bool {
	switch m.ActivePanel {
	case PanelAuth, PanelProviders, PanelModels, PanelPlans:
		return true
	default:
		return false
	}
}

func joinNonEmptyLines(parts ...string) string {
	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		filtered = append(filtered, part)
	}
	return strings.Join(filtered, "\n")
}

func renderPanelHeaderColumns(width int, values ...string) string {
	if len(values) == 0 || width <= 0 {
		return ""
	}
	separatorCount := maxInt(0, len(values)-1)
	availableWidth := maxInt(len(values), width-separatorCount)
	baseWidth := availableWidth / len(values)
	remainder := availableWidth % len(values)
	rendered := make([]string, 0, len(values))
	for index, value := range values {
		cellWidth := baseWidth
		if index < remainder {
			cellWidth++
		}
		text := truncatePlain(strings.ToUpper(strings.TrimSpace(value)), maxInt(1, cellWidth))
		rendered = append(rendered, panelHeaderBarStyle.
			Width(cellWidth).
			MaxWidth(cellWidth).
			Align(lipgloss.Center).
			Render(fitDisplayWidth(text, cellWidth)))
	}
	if len(rendered) == 1 {
		return rendered[0]
	}
	separator := panelHeaderBarStyle.Render("│")
	return strings.Join(rendered, separator)
}

func renderPanelSummaryColumns(width int, values ...string) string {
	if len(values) == 0 || width <= 0 {
		return ""
	}
	baseWidth := width / len(values)
	remainder := width % len(values)
	rendered := make([]string, 0, len(values))
	for index, value := range values {
		cellWidth := baseWidth
		if index < remainder {
			cellWidth++
		}
		text := truncatePlain(strings.ToUpper(strings.TrimSpace(value)), maxInt(1, cellWidth))
		rendered = append(rendered, panelSummaryStyle.
			Width(cellWidth).
			MaxWidth(cellWidth).
			Align(lipgloss.Center).
			Render(fitDisplayWidth(text, cellWidth)))
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, rendered...)
}

func renderPageHeroLine(width int, title, summary string) string {
	text := strings.ToUpper(strings.TrimSpace(title))
	if summary = strings.TrimSpace(summary); summary != "" {
		text += "  |  " + summary
	}
	return pageHeroStyle.
		Width(width).
		MaxWidth(width).
		Render(fitDisplayWidth(text, maxInt(1, width)))
}

func renderPageHintLines(width int, text string) []string {
	if width <= 0 || strings.TrimSpace(text) == "" {
		return nil
	}
	rows := wrapPlainText(text, width)
	lines := make([]string, 0, len(rows))
	for _, row := range rows {
		lines = append(lines, pageHintStyle.Render(row))
	}
	return lines
}

func renderPanelTitleLine(width int, panel Panel, title, summary string) string {
	if width <= 0 {
		return ""
	}
	accent := panelAccentColor(panel)
	titleStyle := panelTitleStyle.Copy().Background(accent)
	mutedStyle := panelTitleMutedStyle.Copy()
	titleText := " " + strings.ToUpper(strings.TrimSpace(title)) + " "
	if strings.TrimSpace(title) == "" {
		titleText = " PANEL "
	}
	renderedTitle := titleStyle.Render(titleText)
	summaryText := strings.TrimSpace(summary)
	if summaryText != "" {
		summaryText = " " + summaryText + " "
	}
	bodyWidth := maxInt(0, width-displayWidth(renderedTitle))
	return renderedTitle + mutedStyle.
		Width(bodyWidth).
		MaxWidth(bodyWidth).
		Render(fitDisplayWidth(summaryText, bodyWidth))
}

func panelAccentColor(panel Panel) lipgloss.Color {
	switch panel {
	case PanelAuth:
		return uiAccentYellowColor
	case PanelProviders:
		return uiAccentCyanColor
	case PanelModels:
		return uiAccentPurpleColor
	case PanelPlans:
		return uiAccentGreenColor
	case PanelApprovals:
		return uiAccentOrangeColor
	default:
		return uiAccentBlueColor
	}
}

func renderPanelSectionLabel(label string) string {
	trimmed := strings.ToUpper(strings.TrimSpace(label))
	if trimmed == "" {
		trimmed = "SECTION"
	}
	return panelSectionStyle.Render(" " + trimmed + " ")
}

func renderPanelErrorBanner(width int, text string) []string {
	if width <= 0 {
		return nil
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	prefix := " ERROR "
	wrapWidth := maxInt(1, width-displayWidth(prefix)-2)
	rows := wrapPlainText(text, wrapWidth)
	if len(rows) == 0 {
		rows = []string{text}
	}
	lines := make([]string, 0, len(rows))
	for index, row := range rows {
		label := strings.Repeat(" ", displayWidth(prefix))
		if index == 0 {
			label = prefix
		}
		line := label + " " + row
		lines = append(lines, panelErrorBannerStyle.
			Width(width).
			MaxWidth(width).
			Render(fitDisplayWidth(line, width)))
	}
	return lines
}

func (m *Model) renderTranscriptWindow(width, height int) ([]string, panelScrollState) {
	allLines := m.renderTranscriptLines(width)
	total := len(allLines)
	if m.shouldShowStartupView() && m.TranscriptOffset == 0 {
		end := minInt(total, height)
		window := allLines[:end]
		lines := make([]string, 0, height)
		topPadding := maxInt(0, (height-len(window))/2)
		for len(lines) < topPadding {
			lines = append(lines, "")
		}
		for _, line := range window {
			lines = append(lines, fitDisplayWidth(line, width))
		}
		for len(lines) < height {
			lines = append(lines, "")
		}
		return lines, panelScrollState{
			Offset:  0,
			Visible: minInt(total, height),
			Total:   total,
		}
	}

	offset := clampInt(m.TranscriptOffset, 0, maxInt(0, total-height))
	end := maxInt(0, total-offset)
	start := maxInt(0, end-height)
	window := allLines[start:end]

	lines := make([]string, 0, height)
	if len(window) > height {
		window = window[len(window)-height:]
	}
	for _, line := range window {
		lines = append(lines, fitDisplayWidth(line, width))
	}
	for len(lines) < height {
		lines = append(lines, "")
	}

	return lines, panelScrollState{
		Offset:  start,
		Visible: minInt(total, height),
		Total:   total,
	}
}

func (m *Model) renderSessionPane(width, height int, active bool) string {
	style := frameStyle.Copy()
	if active {
		style = activeFrameStyle.Copy()
	}
	bodyWidth := framedInnerWidth(style, width)
	bodyHeight := framedInnerHeight(style, height)
	contentWidth := maxInt(1, bodyWidth-2)
	lines, scroll := m.renderTranscriptWindow(contentWidth, maxInt(1, bodyHeight))
	rendered := renderScrollableBlock(lines, bodyWidth, scroll)
	return style.Width(framedRenderWidth(style, width)).Height(framedRenderHeight(style, height)).Render(strings.Join(rendered, "\n"))
}

func (m *Model) renderTranscriptLines(width int) []string {
	if !m.hasAnimatedToolStatus() && m.transcriptCacheWidth == width && m.transcriptCacheVersion == m.transcriptVersion && m.transcriptCacheLines != nil {
		return m.transcriptCacheLines
	}

	if m.shouldShowStartupView() {
		lines := m.renderStartupLines(width)
		if m.ActivePanel != PanelNone {
			lines = m.renderCompactStartupLines(width)
		}
		if !m.hasAnimatedToolStatus() {
			m.transcriptCacheWidth = width
			m.transcriptCacheVersion = m.transcriptVersion
			m.transcriptCacheLines = lines
		}
		return lines
	}

	lines := append([]string(nil), m.renderStaticTranscriptLines(width)...)
	if liveLines := m.renderLiveTranscriptLines(width); len(liveLines) > 0 {
		if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
			lines = append(lines, "")
		}
		lines = append(lines, liveLines...)
	}

	if !m.hasAnimatedToolStatus() {
		m.transcriptCacheWidth = width
		m.transcriptCacheVersion = m.transcriptVersion
		m.transcriptCacheLines = lines
	}
	return lines
}

func (m *Model) renderStaticTranscriptLines(width int) []string {
	if !m.hasAnimatedToolStatus() && m.transcriptStaticCacheWidth == width && m.transcriptStaticCacheLines != nil {
		return m.transcriptStaticCacheLines
	}

	m.syncTranscriptMessageCache()
	lines := m.renderTranscriptItemRange(0, len(m.Items), width)

	if !m.hasAnimatedToolStatus() {
		m.transcriptStaticCacheWidth = width
		m.transcriptStaticCacheLines = lines
	}
	return lines
}

func (m *Model) syncTranscriptMessageCache() {
	switch {
	case len(m.transcriptMessageCache) < len(m.Items):
		m.extendTranscriptMessageCache(len(m.Items) - len(m.transcriptMessageCache))
	case len(m.transcriptMessageCache) > len(m.Items):
		m.transcriptMessageCache = m.transcriptMessageCache[:len(m.Items)]
	}
}

func (m *Model) renderCachedMessageLines(index int, item Message, width int) []string {
	if m.isAnimatedToolStatus(index, item) {
		return m.renderAnimatedToolStatusLines(item, width)
	}

	if index < 0 || index >= len(m.transcriptMessageCache) {
		return renderMessageLines(item, width)
	}

	entry := &m.transcriptMessageCache[index]
	if entry.width == width && entry.lines != nil && transcriptCacheMessageEqual(entry.message, item) {
		return entry.lines
	}

	entry.width = width
	entry.message = item
	entry.lines = renderMessageLines(item, width)
	return entry.lines
}

func transcriptCacheMessageEqual(left, right Message) bool {
	if left.Role != right.Role || left.Kind != right.Kind || left.Text != right.Text {
		return false
	}
	if len(left.Attachments) != len(right.Attachments) {
		return false
	}
	for index := range left.Attachments {
		if left.Attachments[index] != right.Attachments[index] {
			return false
		}
	}
	return true
}

func (m *Model) hasAnimatedToolStatus() bool {
	if !m.isAnimatingStatus() || len(m.Items) == 0 {
		return false
	}
	return isRunningToolStatus(m.Items[len(m.Items)-1])
}

func (m *Model) isAnimatedToolStatus(index int, item Message) bool {
	return m.isAnimatingStatus() && index == len(m.Items)-1 && isRunningToolStatus(item)
}

func (m *Model) renderTranscriptItemRange(start, end, width int) []string {
	start = clampInt(start, 0, len(m.Items))
	end = clampInt(end, start, len(m.Items))
	lines := make([]string, 0, maxInt(0, end-start)*3)
	for index := start; index < end; index++ {
		item := m.Items[index]
		if index > start && item.Role == "user" && item.Kind == "transcript" {
			lines = append(lines, "")
		}
		lines = append(lines, m.renderCachedMessageLines(index, item, width)...)
		if index < end-1 && item.Role == "user" && item.Kind == "transcript" {
			lines = append(lines, "")
			continue
		}
		if index < end-1 && item.Kind == "transcript" && m.Items[index+1].Kind != "transcript" {
			lines = append(lines, "")
		}
	}
	return lines
}

func (m *Model) renderLiveTranscriptLines(width int) []string {
	if strings.TrimSpace(m.LiveText) == "" {
		return nil
	}
	if m.transcriptLiveCacheWidth == width && m.transcriptLiveCacheText == m.LiveText && m.transcriptLiveCacheLines != nil {
		return m.transcriptLiveCacheLines
	}

	lines := renderMessageLines(Message{Role: "assistant", Kind: "transcript", Text: m.LiveText}, width)
	m.transcriptLiveCacheWidth = width
	m.transcriptLiveCacheText = m.LiveText
	m.transcriptLiveCacheLines = lines
	return lines
}

func (m *Model) shouldShowStartupView() bool {
	if strings.TrimSpace(m.LiveText) != "" {
		return false
	}
	if len(m.Items) == 0 {
		return true
	}
	if isDefaultEmptyState(m.Items) || isStartupBridgePlaceholder(m.Items) {
		return true
	}
	return false
}

func (m *Model) renderStartupLines(width int) []string {
	if width <= 0 {
		return []string{""}
	}

	lines := make([]string, 0, 18)
	lines = append(lines, "")
	logoLines, logoWidth := startupLogoLinesForWidth(maxInt(1, minInt(width-2, 72)))
	if len(logoLines) > 0 && width >= 64 {
		for index, line := range logoLines {
			rendered := renderGradientLogoLine(line, index, len(logoLines), logoWidth)
			lines = append(lines, centerLine(rendered, width))
		}
	}

	lines = append(lines, "")
	lines = append(lines, centerLine(startupNameStyle.Render("Start with a task, or use a command:"), width))
	for _, hint := range startupGuideHints(width) {
		lines = append(lines, centerLine(hint, width))
	}
	if status := m.startupRuntimeStatusLine(width); status != "" {
		lines = append(lines, "")
		lines = append(lines, centerLine(status, width))
	}
	return lines
}

func (m *Model) renderCompactStartupLines(width int) []string {
	if width <= 0 {
		return []string{""}
	}
	return []string{
		centerLine(startupTaglineStyle.Render("Type a task below. Use ")+startupCommandStyle.Render("/help")+startupTaglineStyle.Render(" for commands."), width),
	}
}

func startupGuideHints(width int) []string {
	hints := []struct {
		Command string
		Detail  string
	}{
		{Command: "Ask naturally", Detail: "describe the change or question"},
		{Command: "/model", Detail: "switch models"},
		{Command: "/provider", Detail: "change provider"},
		{Command: "Ctrl+O", Detail: "attach images"},
	}
	if width < 72 {
		hints = hints[:2]
	}

	lines := make([]string, 0, len(hints))
	for _, hint := range hints {
		line := startupCommandStyle.Render(hint.Command) +
			startupHintLabelStyle.Render("  ->  ") +
			startupTaglineStyle.Render(hint.Detail)
		lines = append(lines, line)
	}
	return lines
}

func (m *Model) startupRuntimeStatusLine(width int) string {
	if width <= 0 {
		return ""
	}
	workspace := startupWorkspaceLabel(m.AppRoot)
	model := emptyFallback(m.CurrentModel, "none")
	provider := m.providerDisplayName(m.CurrentProvider)
	parts := []string{
		startupHintLabelStyle.Render("WORKSPACE ") + startupTaglineStyle.Render(workspace),
		startupHintLabelStyle.Render("MODEL ") + startupTaglineStyle.Render(model),
		startupHintLabelStyle.Render("PROVIDER ") + startupTaglineStyle.Render(provider),
	}
	return truncateDisplayWidth(strings.Join(parts, startupHintLabelStyle.Render("  ·  ")), width, "")
}

func startupWorkspaceLabel(appRoot string) string {
	trimmed := strings.TrimSpace(appRoot)
	if trimmed == "" || trimmed == "none" {
		return "none"
	}
	base := filepath.Base(trimmed)
	if base == "." || base == string(filepath.Separator) || base == "" {
		return formatProjectPathLabel(trimmed, 24)
	}
	return truncatePlain(base, 24)
}

func centerLine(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if displayWidth(value) >= width {
		return truncateDisplayWidth(value, width, "")
	}
	left := maxInt(0, (width-displayWidth(value))/2)
	return strings.Repeat(" ", left) + value
}

func renderMessageLines(message Message, width int) []string {
	if message.Role == "user" && message.Kind == "transcript" {
		return renderUserTranscriptLines(message, width)
	}

	if message.Kind == "tool_status" {
		style := toolStatusStyleForText(message.Text)
		return renderStyledPrefixedTranscriptLines("", sanitizeTranscriptDisplayText(message), width, style, style)
	}

	if message.Kind == "review_status" {
		return renderReviewStatusTranscriptLines("❯ ", sanitizeTranscriptDisplayText(message), width)
	}

	if shouldRenderCompactTranscript(message) {
		lines := renderPrefixedTranscriptLines("❯ ", sanitizeTranscriptDisplayText(message), width, transcriptBodyStyle(message))
		if len(lines) == 0 {
			return []string{""}
		}
		return lines
	}

	label, labelStyle, contentStyle := messageStyles(message)
	prefixWidth := minInt(10, maxInt(6, width/6))
	bodyWidth := maxInt(1, width-prefixWidth-1)
	renderedBody := renderMarkdownBodyLines(sanitizeTranscriptDisplayText(message), bodyWidth, contentStyle)
	if len(renderedBody) == 0 {
		renderedBody = []string{""}
	}
	lines := make([]string, 0, len(renderedBody))
	prefix := lipgloss.NewStyle().Width(prefixWidth).MaxWidth(prefixWidth).Render(label)
	padding := strings.Repeat(" ", prefixWidth)
	for index, row := range renderedBody {
		if index == 0 {
			lines = append(lines, labelStyle.Render(prefix)+" "+row)
			continue
		}
		lines = append(lines, dimStyle.Render(padding)+" "+row)
	}
	return lines
}

func isRunningToolStatus(message Message) bool {
	return message.Kind == "tool_status" && strings.HasPrefix(strings.TrimSpace(message.Text), "Running ")
}

func (m *Model) renderAnimatedToolStatusLines(message Message, width int) []string {
	text := strings.TrimSpace(message.Text)
	if strings.HasPrefix(text, "Running ") {
		text = strings.TrimPrefix(text, "Running ")
		text = "Calling tool: " + text
	}
	frame := "•"
	if len(statusSpinnerFrames) > 0 {
		frame = statusSpinnerFrames[m.SpinnerFrame%len(statusSpinnerFrames)]
	}
	style := toolStatusStyleForText(message.Text)
	return renderStyledPrefixedTranscriptLines(frame+" ", text, width, style, style)
}

func toolStatusANSIStartForText(text string) string {
	switch toolStatusFamilyForAction(extractToolStatusAction(text)) {
	case "explore":
		return toolStatusExploreANSIStart
	case "read":
		return toolStatusReadANSIStart
	case "semantic":
		return toolStatusSemanticANSIStart
	case "mutation":
		return toolStatusMutationANSIStart
	case "git":
		return toolStatusGitANSIStart
	case "shell":
		return toolStatusShellANSIStart
	default:
		return toolStatusANSIStart
	}
}

func toolStatusStyleForText(text string) lipgloss.Style {
	return lipgloss.NewStyle().Foreground(lipgloss.Color(toolStatusANSIColorForText(text)))
}

func toolStatusANSIColorForText(text string) string {
	switch toolStatusFamilyForAction(extractToolStatusAction(text)) {
	case "explore":
		return "#E3B341"
	case "read":
		return "#58A6FF"
	case "semantic":
		return "#5ED7C8"
	case "mutation":
		return "#7EE787"
	case "git":
		return "#FFA657"
	case "shell":
		return "#EEC45B"
	default:
		return "#8B949E"
	}
}

func extractToolStatusAction(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "Running ") {
		detail := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(trimmed, "Running "), "..."))
		return canonicalizeToolStatusAction(firstToolStatusField(detail))
	}
	for _, prefix := range []string{"Calling tool: ", "Tool: ", "Tool error: ", "Tool result: "} {
		if !strings.HasPrefix(trimmed, prefix) {
			continue
		}
		detail := strings.TrimSpace(strings.TrimPrefix(trimmed, prefix))
		return canonicalizeToolStatusAction(firstToolStatusField(detail))
	}
	return ""
}

func firstToolStatusField(detail string) string {
	head := detail
	if idx := strings.Index(head, " | "); idx >= 0 {
		head = head[:idx]
	}
	fields := strings.Fields(head)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

func canonicalizeToolStatusAction(raw string) string {
	trimmed := strings.ToLower(strings.TrimSpace(raw))
	if trimmed == "" {
		return ""
	}
	compact := compactToolStatusAction(trimmed)
	if compact == "" {
		return trimmed
	}
	if canonical, ok := canonicalToolStatusActionLookup[compact]; ok {
		return canonical
	}
	return trimmed
}

func compactToolStatusAction(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	for _, r := range value {
		switch r {
		case '_', '-', ' ', '\t':
			continue
		default:
			builder.WriteRune(unicode.ToLower(r))
		}
	}
	return builder.String()
}

func buildCanonicalToolStatusActionLookup(actions []string) map[string]string {
	lookup := make(map[string]string, len(actions))
	for _, action := range actions {
		lookup[compactToolStatusAction(action)] = action
	}
	return lookup
}

func toolStatusFamilyForAction(action string) string {
	switch action {
	case "list_dir", "create_dir", "stat_path", "stat_paths", "find_files", "copy_path", "move_path":
		return "explore"
	case "read_file", "read_files", "read_range", "read_json", "read_yaml", "search_text", "search_text_context":
		return "read"
	case "outline_file", "find_symbol", "find_references",
		"ts_hover", "ts_definition", "ts_references", "ts_diagnostics", "ts_prepare_rename",
		"lsp_hover", "lsp_definition", "lsp_implementation", "lsp_type_definition", "lsp_references",
		"lsp_workspace_symbols", "lsp_document_symbols", "lsp_diagnostics", "lsp_prepare_rename",
		"lsp_rename", "lsp_code_actions", "lsp_format_document":
		return "semantic"
	case "create_file", "write_file", "edit_file", "apply_patch", "delete_file":
		return "mutation"
	case "git_status", "git_diff", "git_log", "git_show", "git_blame":
		return "git"
	case "run_command", "run_shell", "open_shell", "write_shell", "read_shell", "shell_status", "interrupt_shell", "close_shell":
		return "shell"
	default:
		return ""
	}
}

func wrapTranscriptLinesWithANSI(lines []string, start, end string) []string {
	if len(lines) == 0 || start == "" {
		return lines
	}
	styled := make([]string, 0, len(lines))
	for _, line := range lines {
		if line == "" {
			styled = append(styled, line)
			continue
		}
		styled = append(styled, start+line+end)
	}
	return styled
}

func renderUserTranscriptLines(message Message, width int) []string {
	if width <= 0 {
		return []string{""}
	}

	prefix := "❯ "
	contentWidth := maxInt(1, width-userBubbleStyle.GetHorizontalFrameSize()-lipgloss.Width(prefix))
	bodyLines := renderMarkdownBodyLines(sanitizeTranscriptDisplayText(message), contentWidth, transcriptBodyStyle(message))
	if len(bodyLines) == 0 {
		bodyLines = []string{""}
	}
	for _, attachment := range message.Attachments {
		name := strings.TrimSpace(attachment.Name)
		if name == "" {
			name = filepath.Base(strings.TrimSpace(attachment.Path))
		}
		bodyLines = append(bodyLines, dimStyle.Render("[image] "+name))
	}

	lines := make([]string, 0, len(bodyLines))
	for index, row := range bodyLines {
		linePrefix := prefix
		if index > 0 {
			linePrefix = "  "
		}
		lines = append(lines, userBubbleStyle.
			Width(width).
			MaxWidth(width).
			Render(fitDisplayWidth(linePrefix+row, contentWidth+lipgloss.Width(prefix))))
	}
	return lines
}

func renderPrefixedTranscriptLines(prefix string, value string, width int, baseStyle lipgloss.Style) []string {
	if width <= 0 {
		return []string{""}
	}
	bodyWidth := maxInt(1, width-lipgloss.Width(prefix))
	bodyLines := renderMarkdownBodyLines(value, bodyWidth, baseStyle)
	if len(bodyLines) == 0 {
		return []string{""}
	}

	lines := make([]string, 0, len(bodyLines))
	for index, row := range bodyLines {
		linePrefix := prefix
		if index > 0 {
			linePrefix = strings.Repeat(" ", lipgloss.Width(prefix))
		}
		lines = append(lines, linePrefix+row)
	}
	return lines
}

func renderStyledPrefixedTranscriptLines(prefix string, value string, width int, prefixStyle lipgloss.Style, baseStyle lipgloss.Style) []string {
	if width <= 0 {
		return []string{""}
	}
	bodyWidth := maxInt(1, width-lipgloss.Width(prefix))
	bodyLines := renderToolStatusBodyLines(value, bodyWidth, baseStyle)
	if len(bodyLines) == 0 {
		return []string{""}
	}

	lines := make([]string, 0, len(bodyLines))
	styledPrefix := prefixStyle.Render(prefix)
	prefixPadding := strings.Repeat(" ", lipgloss.Width(prefix))
	for index, row := range bodyLines {
		if index == 0 {
			lines = append(lines, styledPrefix+row)
			continue
		}
		lines = append(lines, prefixPadding+row)
	}
	return lines
}

func renderReviewStatusTranscriptLines(prefix string, value string, width int) []string {
	if width <= 0 {
		return []string{""}
	}
	bodyWidth := maxInt(1, width-lipgloss.Width(prefix))
	bodyLines := renderReviewStatusBodyLines(value, bodyWidth)
	if len(bodyLines) == 0 {
		return []string{""}
	}

	lines := make([]string, 0, len(bodyLines))
	firstLine := value
	if line, _, ok := strings.Cut(value, "\n"); ok {
		firstLine = line
	}
	styledPrefix := approvalStatusStyle(firstLine).Render(prefix)
	prefixPadding := strings.Repeat(" ", lipgloss.Width(prefix))
	for index, row := range bodyLines {
		if index == 0 {
			lines = append(lines, styledPrefix+row)
			continue
		}
		lines = append(lines, prefixPadding+row)
	}
	return lines
}

func renderReviewStatusBodyLines(value string, width int) []string {
	rawLines := strings.Split(value, "\n")
	if len(rawLines) == 0 {
		return []string{""}
	}

	lines := make([]string, 0, len(rawLines))
	for index, raw := range rawLines {
		if index == 0 {
			lines = append(lines, renderReviewStatusHeaderRows(raw, width)...)
			continue
		}
		detailLines := make([]string, 0, len(rawLines)-1)
		for _, detailRaw := range rawLines[1:] {
			detailLines = append(detailLines, renderReviewStatusDetailRows(detailRaw, maxInt(1, width-4))...)
		}
		if len(detailLines) > 0 {
			lines = append(lines, renderBorderedTranscriptBlock("approval preview", detailLines, width, approvalRequiredStyle)...)
		}
		break
	}
	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}

func renderReviewStatusHeaderRows(raw string, width int) []string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return []string{""}
	}
	parts := splitReviewStatusHeader(trimmed)
	if len(parts) < 2 {
		return renderStyledWrappedLine(trimmed, width, approvalStatusStyle(trimmed))
	}

	status := parts[0]
	action, path := splitToolStatusActionDetail(parts[1])
	id := ""
	if len(parts) > 2 {
		id = parts[2]
	}
	detail := ""
	if len(parts) > 3 {
		detail = strings.Join(parts[3:], " | ")
	}
	return []string{renderReviewStatusHeaderLine(status, action, path, id, detail, width)}
}

func splitReviewStatusHeader(raw string) []string {
	pieces := strings.Split(raw, "|")
	parts := make([]string, 0, len(pieces))
	for _, piece := range pieces {
		trimmed := strings.TrimSpace(piece)
		if trimmed != "" {
			parts = append(parts, trimmed)
		}
	}
	return parts
}

func renderReviewStatusHeaderLine(status, action, path, id, detail string, width int) string {
	separator := approvalSeparatorStyle.Render(" | ")
	statusText := approvalStatusStyle(status).Render(status)
	actionText := ""
	if action != "" {
		actionText = toolStatusStyleForText("Tool: " + action).Bold(true).Render(action)
	}
	pathText := ""
	if strings.TrimSpace(path) != "" {
		pathText = " " + approvalPathStyle.Render(strings.TrimSpace(path))
	}
	idText := ""
	if strings.TrimSpace(id) != "" {
		idText = separator + approvalIDStyle.Render(strings.TrimSpace(id))
	}
	detailText := ""
	if strings.TrimSpace(detail) != "" {
		fixedWidth := lipgloss.Width(status) + 3 + lipgloss.Width(action) + lipgloss.Width(path) + lipgloss.Width(id) + 6
		detailBudget := maxInt(8, width-fixedWidth)
		detailText = separator + approvalDetailStyle.Render(truncatePlain(strings.TrimSpace(detail), detailBudget))
	}

	if actionText == "" {
		return statusText + idText + detailText
	}
	return statusText + separator + actionText + pathText + idText + detailText
}

func approvalStatusStyle(text string) lipgloss.Style {
	normalized := strings.ToLower(strings.TrimSpace(text))
	switch {
	case strings.Contains(normalized, "approved"):
		return approvalApprovedStyle
	case strings.Contains(normalized, "reject"), strings.Contains(normalized, "error"), strings.Contains(normalized, "fail"):
		return approvalRejectedStyle
	case strings.Contains(normalized, "required"), strings.Contains(normalized, "pending"):
		return approvalRequiredStyle
	default:
		return reviewStyle
	}
}

func renderReviewStatusDetailRows(raw string, width int) []string {
	trimmed := strings.TrimSpace(raw)
	switch {
	case diffStatsPattern.MatchString(raw):
		return renderDiffStatsLine(raw, width, approvalDetailStyle)
	case isRecognizedDiffPreviewLine(raw):
		sign, lineNumber, content, _ := parseRenderedDiffLine(raw)
		return renderDiffRows(sign, lineNumber, content, width)
	case strings.HasPrefix(trimmed, "@@"):
		return renderStyledWrappedLine(raw, width, diffHunkStyle)
	case strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]"):
		section := strings.TrimSpace(trimmed[1 : len(trimmed)-1])
		return []string{approvalSectionStyle.Render(truncatePlain("▌ "+emptyFallback(section, "preview"), maxInt(1, width)))}
	case trimmed == "":
		return []string{""}
	case isPipeKVPreviewLine(trimmed):
		return renderPipeKVPreviewLine(trimmed, width)
	}

	key, val, ok := splitPreviewKV(raw)
	if ok {
		return renderApprovalPreviewLines(approvalPreviewLine{Kind: "kv", Key: key, Val: val, Text: raw}, width)
	}
	return renderStyledWrappedLine(raw, width, approvalDetailStyle)
}

func renderStyledWrappedLine(raw string, width int, style lipgloss.Style) []string {
	rows := wrapPlainText(raw, maxInt(1, width))
	if len(rows) == 0 {
		return []string{""}
	}
	rendered := make([]string, 0, len(rows))
	for _, row := range rows {
		rendered = append(rendered, style.Render(row))
	}
	return rendered
}

func isPipeKVPreviewLine(trimmed string) bool {
	if !strings.Contains(trimmed, "|") || !strings.Contains(trimmed, "=") {
		return false
	}
	parts := strings.Split(trimmed, "|")
	if len(parts) < 2 {
		return false
	}
	for _, part := range parts {
		if !headerKVPattern.MatchString(strings.TrimSpace(part)) {
			return false
		}
	}
	return true
}

func renderPipeKVPreviewLine(trimmed string, width int) []string {
	parts := strings.Split(trimmed, "|")
	renderedParts := make([]string, 0, len(parts))
	plainParts := make([]string, 0, len(parts))
	for _, part := range parts {
		key, val, ok := splitPipeKVPart(part)
		if !ok {
			continue
		}
		plainParts = append(plainParts, key+"="+val)
		renderedParts = append(renderedParts, renderPipeKVPart(key, val))
	}
	if len(renderedParts) == 0 {
		return renderStyledWrappedLine(trimmed, width, approvalDetailStyle)
	}
	plain := strings.Join(plainParts, " | ")
	if lipgloss.Width(plain) <= width {
		return []string{strings.Join(renderedParts, approvalSeparatorStyle.Render(" | "))}
	}
	return renderStyledWrappedLine(plain, width, approvalDetailStyle)
}

func splitPipeKVPart(part string) (string, string, bool) {
	pieces := strings.SplitN(strings.TrimSpace(part), "=", 2)
	if len(pieces) != 2 {
		return "", "", false
	}
	key := strings.TrimSpace(pieces[0])
	val := strings.TrimSpace(pieces[1])
	return key, val, key != ""
}

func renderPipeKVPart(key, val string) string {
	keyText := approvalMetaKeyStyle.Render(strings.ToUpper(key))
	valueStyle := approvalMetaValueStyle
	switch strings.ToLower(key) {
	case "action":
		valueStyle = toolStatusStyleForText("Tool: " + val).Bold(true)
	case "path", "destination", "cwd":
		valueStyle = approvalPathStyle
	case "id":
		valueStyle = approvalIDStyle
	case "risk":
		valueStyle = approvalRiskStyle(val)
	}
	return keyText + approvalSeparatorStyle.Render("=") + valueStyle.Render(val)
}

func approvalRiskStyle(value string) lipgloss.Style {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low":
		return approvalApprovedStyle
	case "medium":
		return approvalRequiredStyle
	case "high":
		return approvalRejectedStyle
	default:
		return approvalMetaValueStyle
	}
}

func renderBorderedTranscriptBlock(title string, lines []string, width int, borderStyle lipgloss.Style) []string {
	if width < 8 {
		return lines
	}
	innerWidth := maxInt(1, width-4)
	label := strings.TrimSpace(title)
	topText := "╭"
	if label != "" {
		visibleTitle := truncatePlain(label, maxInt(1, width-6))
		topText += "─ " + visibleTitle + " "
	}
	topText += strings.Repeat("─", maxInt(0, width-lipgloss.Width(topText)-1)) + "╮"
	bottomText := "╰" + strings.Repeat("─", maxInt(0, width-2)) + "╯"

	rendered := make([]string, 0, len(lines)+2)
	rendered = append(rendered, borderStyle.Render(topText))
	for _, line := range lines {
		content := fitDisplayWidth(line, innerWidth)
		rendered = append(rendered,
			borderStyle.Render("│ ")+content+borderStyle.Render(" │"),
		)
	}
	rendered = append(rendered, borderStyle.Render(bottomText))
	return rendered
}

func renderDiffTranscriptBlock(rawLines []string, width int, title string) ([]string, int) {
	return renderDiffTranscriptBlockMatching(rawLines, width, title, isDiffBlockLine)
}

func renderMarkdownDiffTranscriptBlock(rawLines []string, width int, title string) ([]string, int) {
	return renderDiffTranscriptBlockMatching(rawLines, width, title, isMarkdownDiffBlockLine)
}

func renderDiffTranscriptBlockMatching(rawLines []string, width int, title string, matches func(string) bool) ([]string, int) {
	innerWidth := maxInt(1, width-4)
	blockLines := make([]string, 0, len(rawLines))
	consumed := 0
	for _, raw := range rawLines {
		if consumed > 0 && isDiffContinuationLine(raw) {
			blockLines = append(blockLines, renderDiffBlockLineRows(raw, innerWidth)...)
			consumed++
			continue
		}
		if consumed > 0 && !matches(raw) {
			break
		}
		if !matches(raw) {
			break
		}
		blockLines = append(blockLines, renderDiffBlockLineRows(raw, innerWidth)...)
		consumed++
	}
	if consumed == 0 {
		return nil, 0
	}
	return renderBorderedTranscriptBlock(title, blockLines, width, diffHunkStyle), consumed
}

func isDiffContinuationLine(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	return trimmed == "(none)"
}

func isDiffBlockLine(raw string) bool {
	if isMarkdownDiffBlockLine(raw) {
		return true
	}
	return strings.HasPrefix(raw, "+") || strings.HasPrefix(raw, "-")
}

func isMarkdownDiffBlockLine(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return false
	}
	if diffStatsPattern.MatchString(raw) ||
		diffPreviewOmittedPattern.MatchString(trimmed) ||
		isRecognizedDiffPreviewLine(raw) ||
		strings.HasPrefix(trimmed, "@@") ||
		strings.HasPrefix(trimmed, "diff --git ") ||
		strings.HasPrefix(trimmed, "index ") ||
		strings.HasPrefix(trimmed, "--- ") ||
		strings.HasPrefix(trimmed, "+++ ") {
		return true
	}
	if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
		section := strings.ToLower(strings.TrimSpace(trimmed[1 : len(trimmed)-1]))
		return strings.Contains(section, "diff") ||
			strings.Contains(section, "preview") ||
			section == "unstaged" ||
			section == "staged" ||
			strings.Contains(section, "old -") ||
			strings.Contains(section, "new +")
	}
	return false
}

func renderDiffBlockLineRows(raw string, width int) []string {
	trimmed := strings.TrimSpace(raw)
	switch {
	case diffStatsPattern.MatchString(raw):
		return renderDiffStatsLine(raw, width, approvalDetailStyle)
	case diffPreviewOmittedPattern.MatchString(trimmed):
		matches := diffPreviewOmittedPattern.FindStringSubmatch(trimmed)
		if len(matches) == 2 {
			return []string{dimStyle.Render(truncatePlain("... "+matches[1]+" more changed line(s)", width))}
		}
	case isRecognizedDiffPreviewLine(raw):
		sign, lineNumber, content, _ := parseRenderedDiffLine(raw)
		return renderDiffRows(sign, lineNumber, content, width)
	case strings.HasPrefix(trimmed, "@@"),
		strings.HasPrefix(trimmed, "diff --git "),
		strings.HasPrefix(trimmed, "index "),
		strings.HasPrefix(trimmed, "--- "),
		strings.HasPrefix(trimmed, "+++ "):
		return renderStyledWrappedLine(raw, width, diffHunkStyle)
	case strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]"):
		section := strings.TrimSpace(trimmed[1 : len(trimmed)-1])
		return []string{approvalSectionStyle.Render(truncatePlain("▌ "+emptyFallback(section, "diff preview"), width))}
	case trimmed == "(none)":
		return renderStyledWrappedLine(raw, width, dimStyle)
	case strings.HasPrefix(raw, "+"):
		return renderDiffRows("+", "", strings.TrimPrefix(raw, "+"), width)
	case strings.HasPrefix(raw, "-"):
		return renderDiffRows("-", "", strings.TrimPrefix(raw, "-"), width)
	}
	return renderStyledWrappedLine(raw, width, approvalDetailStyle)
}

func renderToolStatusBodyLines(value string, width int, baseStyle lipgloss.Style) []string {
	if width <= 0 {
		return []string{""}
	}
	rawLines := strings.Split(value, "\n")
	lines := make([]string, 0, len(rawLines))
	for index := 0; index < len(rawLines); index++ {
		raw := rawLines[index]
		trimmed := strings.TrimSpace(raw)
		if isDiffBlockLine(raw) {
			blockRows, consumed := renderDiffTranscriptBlock(rawLines[index:], width, "diff preview")
			lines = append(lines, blockRows...)
			index += consumed - 1
			continue
		}
		switch {
		case diffStatsPattern.MatchString(raw):
			lines = append(lines, renderDiffStatsLine(raw, width, baseStyle)...)
		case isRecognizedDiffPreviewLine(raw):
			sign, lineNumber, content, _ := parseRenderedDiffLine(raw)
			lines = append(lines, renderDiffRows(sign, lineNumber, content, width)...)
		case strings.HasPrefix(trimmed, "@@"):
			for _, row := range wrapPlainText(raw, width) {
				lines = append(lines, diffHunkStyle.Render(row))
			}
		case strings.HasPrefix(trimmed, "[diff preview]"):
			for _, row := range wrapPlainText(raw, width) {
				lines = append(lines, sectionStyle.Render(row))
			}
		case trimmed == "":
			lines = append(lines, "")
		default:
			lines = append(lines, renderToolStatusLineRows(raw, width, baseStyle)...)
		}
	}
	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}

func renderToolStatusLineRows(raw string, width int, baseStyle lipgloss.Style) []string {
	prefix, detail, ok := splitToolStatusDisplayLine(raw)
	if !ok {
		rows := wrapPlainText(raw, width)
		if len(rows) == 0 {
			return []string{""}
		}
		rendered := make([]string, 0, len(rows))
		for _, row := range rows {
			rendered = append(rendered, baseStyle.Render(row))
		}
		return rendered
	}

	if rows := renderToolStatusChipRows(prefix, detail, width); rows != nil {
		return rows
	}

	plain := prefix + " " + detail
	rows := wrapPlainText(plain, width)
	if len(rows) == 0 {
		return []string{""}
	}
	rendered := make([]string, 0, len(rows))
	rendered = append(rendered, renderToolStatusStructuredRow(prefix, detail, rows[0]))
	for _, row := range rows[1:] {
		rendered = append(rendered, toolDetailStyle.Render(row))
	}
	return rendered
}

func renderToolStatusChipRows(prefix, detail string, width int) []string {
	action, rest := splitToolStatusActionDetail(detail)
	if action == "" {
		return nil
	}
	source := prefix + " " + detail
	family := toolStatusFamilyForAction(canonicalizeToolStatusAction(action))
	if family == "" {
		family = "tool"
	}
	chip := toolChipStyle.Copy().
		Background(lipgloss.Color(toolStatusANSIColorForText(source))).
		Render(family + " " + canonicalizeToolStatusAction(action))
	detailText := strings.TrimSpace(rest)
	detailText = strings.TrimSuffix(detailText, "...")
	detailText = strings.TrimPrefix(detailText, "|")
	detailText = strings.TrimSpace(detailText)
	detailText = emptyFallback(detailText, "running")
	bodyWidth := maxInt(1, width-displayWidth(chip)-1)
	bodyRows := wrapPlainText(detailText, bodyWidth)
	if len(bodyRows) == 0 {
		bodyRows = []string{""}
	}
	rendered := make([]string, 0, len(bodyRows))
	padding := strings.Repeat(" ", displayWidth(chip)+1)
	for index, row := range bodyRows {
		if index == 0 {
			rendered = append(rendered, chip+" "+toolDetailDimStyle.Render(row))
			continue
		}
		rendered = append(rendered, padding+toolDetailDimStyle.Render(row))
	}
	return rendered
}

func splitToolStatusDisplayLine(raw string) (string, string, bool) {
	trimmed := strings.TrimSpace(raw)
	prefixes := []string{"Calling tool:", "Tool error:", "Tool result:", "Tool:", "Running"}
	for _, prefix := range prefixes {
		if !strings.HasPrefix(trimmed, prefix) {
			continue
		}
		detail := strings.TrimSpace(strings.TrimPrefix(trimmed, prefix))
		if detail == "" {
			return prefix, "", true
		}
		return prefix, detail, true
	}
	return "", "", false
}

func renderToolStatusStructuredRow(prefix, detail, row string) string {
	prefixText := prefix + " "
	prefixStyle := toolPrefixStyle
	if strings.Contains(strings.ToLower(prefix), "error") {
		prefixStyle = toolErrorPrefixStyle
	}
	if !strings.HasPrefix(row, prefixText) {
		return toolDetailStyle.Render(row)
	}

	rowDetail := strings.TrimPrefix(row, prefixText)
	action, rest := splitToolStatusActionDetail(rowDetail)
	actionStyle := toolStatusStyleForText(prefixText + detail).Bold(true)
	rendered := prefixStyle.Render(prefixText)
	if action != "" {
		rendered += actionStyle.Render(action)
	}
	if rest != "" {
		rendered += toolDetailStyle.Render(rest)
	}
	return rendered
}

func splitToolStatusActionDetail(detail string) (string, string) {
	fields := strings.Fields(detail)
	if len(fields) == 0 {
		return "", ""
	}
	action := fields[0]
	rest := strings.TrimPrefix(detail, action)
	return action, rest
}

func sanitizeTranscriptDisplayText(message Message) string {
	if message.Kind == "tool_status" {
		return normalizeToolStatusDisplayText(compactToolStatusDisplayText(stripLeakedToolProtocolText(message.Text)))
	}
	if message.Role == "system" || message.Kind == "review_status" || message.Kind == "system_hint" {
		return normalizeToolStatusDisplayText(compactToolStatusDisplayText(stripLeakedToolProtocolText(message.Text)))
	}
	if message.Role != "assistant" || message.Kind != "transcript" {
		return normalizeToolStatusDisplayText(message.Text)
	}
	return normalizeToolStatusDisplayText(stripLeakedToolProtocolText(message.Text))
}

func normalizeToolStatusDisplayText(text string) string {
	if strings.TrimSpace(text) == "" {
		return text
	}
	lines := strings.Split(text, "\n")
	if len(lines) == 0 {
		return text
	}
	for index, line := range lines {
		lines[index] = normalizeToolStatusDisplayLine(line)
	}
	return strings.Join(lines, "\n")
}

func normalizeToolStatusDisplayLine(line string) string {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return line
	}

	for _, prefix := range []string{"Calling tool:", "Tool error:", "Tool result:", "Tool:", "Running"} {
		index := findToolStatusPrefixIndex(line, prefix)
		if index < 0 {
			continue
		}
		detailStart := index + len(prefix)
		if prefix == "Running" {
			if detailStart >= len(line) || !isToolStatusSeparatorRune(rune(line[detailStart])) {
				continue
			}
		}
		detail := line[detailStart:]
		separator := " "
		if strings.HasSuffix(prefix, ":") {
			separator = ": "
			prefix = strings.TrimSuffix(prefix, ":")
		}
		return line[:index] + prefix + separator + normalizeToolStatusDetail(detail)
	}
	return line
}

func findToolStatusPrefixIndex(line, prefix string) int {
	searchStart := 0
	for {
		index := strings.Index(line[searchStart:], prefix)
		if index < 0 {
			return -1
		}
		index += searchStart
		if index == 0 || isToolStatusPrefixBoundary(line[:index]) {
			return index
		}
		searchStart = index + len(prefix)
		if searchStart >= len(line) {
			return -1
		}
	}
}

func isToolStatusPrefixBoundary(before string) bool {
	trimmed := strings.TrimSpace(before)
	if trimmed == "" {
		return true
	}
	for _, r := range trimmed {
		switch r {
		case '❯', '›', '>', '•', '-', '|', '│':
			continue
		default:
			return false
		}
	}
	return true
}

func isToolStatusSeparatorRune(r rune) bool {
	return r == ' ' || r == '\t' || r == '|'
}

func normalizeToolStatusDetail(detail string) string {
	trailingDots := ""
	trimmed := strings.TrimSpace(detail)
	if strings.HasSuffix(trimmed, "...") {
		trailingDots = "..."
		trimmed = strings.TrimSuffix(trimmed, "...")
	}

	head := trimmed
	rest := ""
	if idx := strings.Index(trimmed, " | "); idx >= 0 {
		head = trimmed[:idx]
		rest = trimmed[idx:]
	}
	fields := strings.Fields(head)
	if len(fields) == 0 {
		return detail
	}
	canonical := canonicalizeToolStatusAction(fields[0])
	if canonical == fields[0] {
		return strings.TrimSpace(detail)
	}
	fields[0] = canonical
	return strings.Join(fields, " ") + rest + trailingDots
}

func compactToolStatusDisplayText(text string) string {
	lines := strings.Split(text, "\n")
	path := ""
	diffSummary := ""
	hasFileMutation := false
	diffPreviewLines := make([]string, 0, len(lines))
	diffPreviewOmitted := 0
	inDiffPreview := false

	for _, raw := range lines {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		if inDiffPreview {
			if matches := diffPreviewOmittedPattern.FindStringSubmatch(trimmed); len(matches) == 2 {
				diffPreviewOmitted, _ = strconv.Atoi(matches[1])
				inDiffPreview = false
				continue
			}
			if isFileMutationMetadataLine(trimmed) {
				inDiffPreview = false
				continue
			}
			diffPreviewLines = append(diffPreviewLines, trimmed)
			continue
		}
		if matches := diffStatsPattern.FindStringSubmatch(trimmed); len(matches) == 3 {
			diffSummary = "diff: " + matches[1] + " " + matches[2]
			continue
		}
		if matches := diffPreviewOmittedPattern.FindStringSubmatch(trimmed); len(matches) == 2 {
			diffPreviewOmitted, _ = strconv.Atoi(matches[1])
			continue
		}
		if trimmed == "[diff preview]" {
			inDiffPreview = true
			continue
		}
		if isRecognizedDiffPreviewLine(trimmed) {
			diffPreviewLines = append(diffPreviewLines, trimmed)
			continue
		}
		if matches := fileMutationReceiptPattern.FindStringSubmatch(trimmed); len(matches) == 2 {
			path = strings.TrimSpace(matches[1])
			hasFileMutation = true
			continue
		}
		if matches := confirmedMutationLinePattern.FindStringSubmatch(trimmed); len(matches) == 3 {
			if path == "" {
				path = strings.TrimSpace(matches[2])
			}
			hasFileMutation = true
			continue
		}
		if matches := fileMutationToolLinePattern.FindStringSubmatch(trimmed); len(matches) == 3 {
			if path == "" {
				path = strings.TrimSpace(matches[2])
			}
			hasFileMutation = true
			continue
		}
	}

	if !hasFileMutation || path == "" {
		return text
	}

	summary := []string{path}
	if diffSummary != "" {
		summary = append(summary, diffSummary)
	}
	if len(diffPreviewLines) > 0 {
		summary = append(summary, diffPreviewLines...)
		if diffPreviewOmitted > 0 {
			summary = append(summary, fmt.Sprintf("... %d more changed line(s)", diffPreviewOmitted))
		}
	}
	return strings.Join(summary, "\n")
}

func isFileMutationMetadataLine(trimmed string) bool {
	switch {
	case diffStatsPattern.MatchString(trimmed),
		fileMutationReceiptPattern.MatchString(trimmed),
		confirmedMutationLinePattern.MatchString(trimmed),
		fileMutationToolLinePattern.MatchString(trimmed),
		strings.HasPrefix(trimmed, "postcondition:"),
		strings.HasPrefix(trimmed, "bytes_before:"),
		strings.HasPrefix(trimmed, "bytes_after:"),
		strings.HasPrefix(trimmed, "lines_before:"),
		strings.HasPrefix(trimmed, "lines_after:"),
		strings.HasPrefix(trimmed, "next:"):
		return true
	default:
		return false
	}
}

func isRecognizedDiffPreviewLine(raw string) bool {
	_, _, _, ok := parseRenderedDiffLine(raw)
	return ok
}

func parseRenderedDiffLine(raw string) (sign, lineNumber, content string, ok bool) {
	if parts := diffPattern.FindStringSubmatch(raw); len(parts) == 4 {
		return parts[1], strings.TrimSpace(parts[2]), parts[3], true
	}
	if parts := maskedDiffPattern.FindStringSubmatch(strings.TrimSpace(raw)); len(parts) == 3 {
		return parts[1], "", parts[2], true
	}
	return "", "", "", false
}

func stripLeakedToolProtocolText(text string) string {
	rawLines := strings.Split(text, "\n")
	filtered := make([]string, 0, len(rawLines))
	lastBlank := false
	for _, raw := range rawLines {
		trimmed := strings.TrimSpace(raw)
		if isLeakedToolProtocolLine(trimmed) {
			continue
		}
		if trimmed == "" {
			if lastBlank {
				continue
			}
			lastBlank = true
			filtered = append(filtered, "")
			continue
		}
		lastBlank = false
		filtered = append(filtered, raw)
	}

	return strings.Trim(strings.Join(filtered, "\n"), "\n")
}

func isLeakedToolProtocolLine(trimmed string) bool {
	if trimmed == "" {
		return false
	}
	switch {
	case strings.HasPrefix(trimmed, "<invoke "),
		strings.HasPrefix(trimmed, "</invoke"),
		strings.HasPrefix(trimmed, "<parameter "),
		strings.HasPrefix(trimmed, "</parameter"),
		strings.HasPrefix(trimmed, "<minimax:tool_call"),
		strings.HasPrefix(trimmed, "</minimax:tool_call"),
		(strings.HasPrefix(trimmed, "{") && leakedToolActionJSONPattern.MatchString(trimmed)),
		leakedFunctionCallPattern.MatchString(trimmed):
		return true
	default:
		return false
	}
}

func renderMarkdownBodyLines(value string, width int, baseStyle lipgloss.Style) []string {
	if width <= 0 {
		return []string{""}
	}

	rawLines := strings.Split(value, "\n")
	lines := make([]string, 0, len(rawLines))

	for index := 0; index < len(rawLines); index++ {
		raw := rawLines[index]
		trimmed := strings.TrimSpace(raw)
		if marker, lang, ok := parseMarkdownFenceLine(trimmed); ok {
			rendered, consumed := renderMarkdownCodeBlock(rawLines[index+1:], marker, lang, width)
			lines = append(lines, rendered...)
			index += consumed
			continue
		}

		if table, consumed, ok := parseMarkdownTable(rawLines[index:]); ok {
			lines = append(lines, renderMarkdownTable(table, width, baseStyle)...)
			index += consumed - 1
			continue
		}

		if trimmed != "" && index+1 < len(rawLines) {
			if level, ok := parseSetextHeadingLevel(strings.TrimSpace(rawLines[index+1])); ok {
				heading := strings.TrimSpace(raw)
				for _, row := range wrapPlainText(heading, width) {
					lines = append(lines, markdownHeadingStyle(level).Render(row))
				}
				index++
				continue
			}
		}

		if markdownRulePattern.MatchString(trimmed) {
			lines = append(lines, ruleStyle.Render(strings.Repeat("─", maxInt(3, width))))
			continue
		}

		quoteDepth, quoteContent, hasQuote := parseMarkdownQuote(raw)
		quotePrefix := ""
		if hasQuote {
			quotePrefix = renderMarkdownQuotePrefix(quoteDepth)
			raw = quoteContent
			trimmed = strings.TrimSpace(quoteContent)
		}

		if !hasQuote && isMarkdownDiffBlockLine(raw) {
			blockRows, consumed := renderMarkdownDiffTranscriptBlock(rawLines[index:], width, "diff preview")
			lines = append(lines, blockRows...)
			index += consumed - 1
			continue
		}

		switch {
		case diffStatsPattern.MatchString(raw):
			lines = append(lines, renderDiffStatsLine(raw, width, baseStyle)...)
		case isRecognizedDiffPreviewLine(raw):
			sign, lineNumber, content, _ := parseRenderedDiffLine(raw)
			lines = append(lines, renderDiffRows(sign, lineNumber, content, width)...)
		case strings.HasPrefix(trimmed, "@@"):
			for _, row := range wrapPlainText(raw, width) {
				lines = append(lines, diffHunkStyle.Render(row))
			}
		case strings.HasPrefix(trimmed, "[diff preview]"),
			strings.HasPrefix(trimmed, "[create preview"),
			strings.HasPrefix(trimmed, "[write preview"),
			strings.HasPrefix(trimmed, "[edit preview"),
			strings.HasPrefix(trimmed, "[patch preview"),
			strings.HasPrefix(trimmed, "[old -"),
			strings.HasPrefix(trimmed, "[new +"):
			for _, row := range wrapPlainText(raw, width) {
				lines = append(lines, sectionStyle.Render(row))
			}
		case strings.HasPrefix(trimmed, "#"):
			level, heading := parseATXHeading(trimmed)
			for _, row := range wrapPlainText(heading, width) {
				lines = append(lines, markdownHeadingStyle(level).Render(row))
			}
		case orderedListPattern.MatchString(raw):
			prefix, content := renderMarkdownListPrefix(orderedListPattern.FindStringSubmatch(raw), true)
			rendered, consumed := renderMarkdownListBlock(rawLines, index, width, quotePrefix+prefix, content, markdownIndentWidth(raw), baseStyle)
			lines = append(lines, rendered...)
			index += consumed
		case unorderedListPattern.MatchString(raw):
			prefix, content := renderMarkdownListPrefix(unorderedListPattern.FindStringSubmatch(raw), false)
			rendered, consumed := renderMarkdownListBlock(rawLines, index, width, quotePrefix+prefix, content, markdownIndentWidth(raw), baseStyle)
			lines = append(lines, rendered...)
			index += consumed
		case trimmed == "":
			lines = append(lines, "")
		case hasQuote:
			for index, row := range wrapPlainText(raw, maxInt(1, width-lipgloss.Width(quotePrefix))) {
				linePrefix := quotePrefix
				if index > 0 {
					linePrefix = strings.Repeat(" ", lipgloss.Width(quotePrefix))
				}
				lines = append(lines, linePrefix+renderInlineMarkdown(row, dimStyle.Copy()))
			}
		default:
			for _, row := range wrapPlainText(raw, width) {
				lines = append(lines, renderInlineMarkdown(row, baseStyle))
			}
		}
	}

	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}

func parseMarkdownFenceLine(trimmed string) (marker string, lang string, ok bool) {
	switch {
	case strings.HasPrefix(trimmed, "```"):
		return "```", strings.TrimSpace(strings.TrimPrefix(trimmed, "```")), true
	case strings.HasPrefix(trimmed, "~~~"):
		return "~~~", strings.TrimSpace(strings.TrimPrefix(trimmed, "~~~")), true
	default:
		return "", "", false
	}
}

func renderMarkdownCodeBlock(rawLines []string, marker, lang string, width int) ([]string, int) {
	codeLines := make([]string, 0, len(rawLines))
	consumed := 0
	for consumed < len(rawLines) {
		trimmed := strings.TrimSpace(rawLines[consumed])
		if nextMarker, _, ok := parseMarkdownFenceLine(trimmed); ok && sameMarkdownFenceFamily(marker, nextMarker) {
			break
		}
		codeLines = append(codeLines, rawLines[consumed])
		consumed++
	}
	if consumed < len(rawLines) {
		consumed++
	}
	return renderMarkdownCodeBlockLines(codeLines, lang, width), consumed
}

func renderMarkdownCodeBlockLines(codeLines []string, lang string, width int) []string {
	if width <= 0 {
		return []string{""}
	}

	label := " code "
	if trimmedLang := strings.TrimSpace(lang); trimmedLang != "" {
		label = " code " + trimmedLang + " "
	}

	lineCount := maxInt(1, len(codeLines))
	gutterWidth := maxInt(4, len(strconv.Itoa(lineCount))+2)
	innerWidth := maxInt(lipgloss.Width(label)+2, width-2)
	contentWidth := maxInt(8, innerWidth-gutterWidth-1)
	innerWidth = gutterWidth + 1 + contentWidth

	topFillWidth := maxInt(0, innerWidth-lipgloss.Width(label))
	topLine := codeBlockBorderStyle.Render("╭") +
		codeBlockHeaderStyle.Render(label) +
		codeBlockBorderStyle.Render(strings.Repeat("─", topFillWidth)+"╮")

	rendered := []string{fitDisplayWidth(topLine, width)}
	if len(codeLines) == 0 {
		codeLines = []string{""}
	}

	for index, raw := range codeLines {
		wrapped := wrapPlainText(raw, contentWidth)
		if len(wrapped) == 0 {
			wrapped = []string{""}
		}
		for wrapIndex, row := range wrapped {
			lineNo := ""
			if wrapIndex == 0 {
				lineNo = strconv.Itoa(index + 1)
			}
			rendered = append(rendered, renderMarkdownCodeBlockRow(lineNo, row, gutterWidth, contentWidth, width))
		}
	}

	bottomLine := codeBlockBorderStyle.Render("╰" + strings.Repeat("─", innerWidth) + "╯")
	rendered = append(rendered, fitDisplayWidth(bottomLine, width))
	return rendered
}

func renderMarkdownCodeBlockRow(lineNo, content string, gutterWidth, contentWidth, width int) string {
	gutterText := lineNo
	if gutterText != "" {
		gutterText = strings.Repeat(" ", maxInt(0, gutterWidth-lipgloss.Width(gutterText))) + gutterText
	} else {
		gutterText = strings.Repeat(" ", gutterWidth)
	}
	leftBorder := codeBlockBorderStyle.Render("│")
	gutter := codeBlockLineNoStyle.Render(gutterText)
	separator := codeBlockBorderStyle.Render("│")
	code := codeBlockStyle.Render(fitDisplayWidth(renderCodeLine(content), contentWidth))
	rightBorder := codeBlockBorderStyle.Render("│")
	return fitDisplayWidth(leftBorder+gutter+separator+code+rightBorder, width)
}

func sameMarkdownFenceFamily(left, right string) bool {
	if left == "" || right == "" {
		return false
	}
	return left[0] == right[0]
}

func parseSetextHeadingLevel(trimmed string) (int, bool) {
	matches := setextHeadingPattern.FindStringSubmatch(trimmed)
	if len(matches) != 2 {
		return 0, false
	}
	if strings.HasPrefix(matches[1], "=") {
		return 1, true
	}
	return 2, true
}

func parseATXHeading(trimmed string) (int, string) {
	level := 0
	for level < len(trimmed) && level < 6 && trimmed[level] == '#' {
		level++
	}
	heading := strings.TrimSpace(trimmed[level:])
	heading = strings.TrimSpace(strings.TrimRight(heading, "#"))
	return maxInt(1, level), heading
}

func markdownHeadingStyle(level int) lipgloss.Style {
	switch {
	case level <= 1:
		return titleStyle.Copy()
	case level == 2:
		return subtitleStyle.Copy()
	default:
		return minorTitleStyle.Copy()
	}
}

func parseMarkdownQuote(raw string) (depth int, content string, ok bool) {
	remaining := strings.TrimLeft(raw, " \t")
	for strings.HasPrefix(remaining, ">") {
		depth++
		remaining = strings.TrimLeft(strings.TrimPrefix(remaining, ">"), " ")
	}
	if depth == 0 {
		return 0, raw, false
	}
	return depth, remaining, true
}

func renderMarkdownQuotePrefix(depth int) string {
	if depth <= 0 {
		return ""
	}
	return dimStyle.Render(strings.Repeat("│ ", depth))
}

func renderMarkdownListPrefix(matches []string, ordered bool) (string, string) {
	if ordered {
		if len(matches) < 4 {
			return "", ""
		}
		indent := markdownIndentPrefix(matches[1])
		prefix := indent + dimStyle.Render(strings.TrimSpace(matches[2])+". ")
		content := matches[3]
		return applyTaskListMarker(prefix, content)
	}
	if len(matches) < 4 {
		return "", ""
	}
	indent := markdownIndentPrefix(matches[1])
	level := markdownIndentLevel(matches[1])
	prefix := indent + dimStyle.Render(markdownBulletForLevel(level)+" ")
	content := matches[3]
	return applyTaskListMarker(prefix, content)
}

func renderMarkdownListBlock(rawLines []string, start, width int, prefix, content string, baseIndent int, baseStyle lipgloss.Style) ([]string, int) {
	lines := make([]string, 0, 4)
	contentWidth := maxInt(1, width-lipgloss.Width(prefix))
	for index, row := range wrapPlainText(content, contentWidth) {
		if index == 0 {
			lines = append(lines, prefix+renderInlineMarkdown(row, baseStyle))
			continue
		}
		lines = append(lines, strings.Repeat(" ", lipgloss.Width(prefix))+renderInlineMarkdown(row, baseStyle))
	}

	continuations, consumed := collectMarkdownListContinuations(rawLines, start+1, baseIndent)
	continuationPrefix := strings.Repeat(" ", lipgloss.Width(prefix))
	continuationWidth := maxInt(1, width-lipgloss.Width(continuationPrefix))
	for _, paragraph := range continuations {
		if paragraph == "" {
			lines = append(lines, "")
			continue
		}
		for _, row := range wrapPlainText(paragraph, continuationWidth) {
			lines = append(lines, continuationPrefix+renderInlineMarkdown(row, baseStyle))
		}
	}

	return lines, consumed
}

func collectMarkdownListContinuations(rawLines []string, start, baseIndent int) ([]string, int) {
	paragraphs := make([]string, 0, 2)
	consumed := 0
	current := make([]string, 0, 2)

	flush := func() {
		if len(current) == 0 {
			return
		}
		paragraphs = append(paragraphs, strings.Join(current, " "))
		current = current[:0]
	}

	for start+consumed < len(rawLines) {
		raw := rawLines[start+consumed]
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			if hasMarkdownListContinuation(rawLines, start+consumed+1, baseIndent) {
				flush()
				paragraphs = append(paragraphs, "")
				consumed++
				continue
			}
			break
		}

		if markdownIndentWidth(raw) <= baseIndent || isMarkdownListBoundary(raw) {
			break
		}

		current = append(current, strings.TrimSpace(raw))
		consumed++
	}

	flush()
	return paragraphs, consumed
}

func hasMarkdownListContinuation(rawLines []string, start, baseIndent int) bool {
	for start < len(rawLines) {
		raw := rawLines[start]
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			start++
			continue
		}
		return markdownIndentWidth(raw) > baseIndent && !isMarkdownListBoundary(raw)
	}
	return false
}

func isMarkdownListBoundary(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return false
	}
	if _, _, ok := parseMarkdownFenceLine(trimmed); ok {
		return true
	}
	if orderedListPattern.MatchString(raw) || unorderedListPattern.MatchString(raw) {
		return true
	}
	return strings.HasPrefix(trimmed, "#") ||
		markdownRulePattern.MatchString(trimmed) ||
		setextHeadingPattern.MatchString(trimmed) ||
		strings.HasPrefix(trimmed, ">") ||
		diffStatsPattern.MatchString(trimmed) ||
		isRecognizedDiffPreviewLine(trimmed) ||
		strings.HasPrefix(trimmed, "@@") ||
		strings.HasPrefix(trimmed, "[diff preview]") ||
		strings.HasPrefix(trimmed, "[create preview") ||
		strings.HasPrefix(trimmed, "[write preview") ||
		strings.HasPrefix(trimmed, "[edit preview") ||
		strings.HasPrefix(trimmed, "[patch preview") ||
		strings.HasPrefix(trimmed, "[old -") ||
		strings.HasPrefix(trimmed, "[new +")
}

func applyTaskListMarker(prefix, content string) (string, string) {
	matches := taskListPattern.FindStringSubmatch(strings.TrimSpace(content))
	if len(matches) != 3 {
		return prefix, content
	}
	marker := taskTodoStyle.Render("☐")
	if strings.EqualFold(matches[1], "x") {
		marker = taskDoneStyle.Render("☑")
	}
	return prefix + marker + " ", matches[2]
}

func markdownIndentLevel(rawIndent string) int {
	width := 0
	for _, r := range rawIndent {
		if r == '\t' {
			width += 4
			continue
		}
		width++
	}
	return maxInt(0, width/2)
}

func markdownIndentWidth(raw string) int {
	width := 0
	for _, r := range raw {
		if r == ' ' {
			width++
			continue
		}
		if r == '\t' {
			width += 4
			continue
		}
		break
	}
	return width
}

func markdownIndentPrefix(rawIndent string) string {
	return strings.Repeat("  ", markdownIndentLevel(rawIndent))
}

func markdownBulletForLevel(level int) string {
	switch level % 3 {
	case 1:
		return "◦"
	case 2:
		return "▪"
	default:
		return "•"
	}
}

func renderDiffStatsLine(raw string, width int, baseStyle lipgloss.Style) []string {
	parts := diffStatsPattern.FindStringSubmatch(raw)
	if len(parts) != 3 {
		return []string{fitDisplayWidth(raw, width)}
	}

	addDigits := strings.TrimPrefix(parts[1], "+")
	removeDigits := strings.TrimPrefix(parts[2], "-")
	rendered := baseStyle.Render("diff: ") +
		diffAddSignANSI + "+" + diffANSIEnd +
		baseStyle.Render(addDigits) +
		" " +
		diffRemoveSignANSI + "-" + diffANSIEnd +
		baseStyle.Render(removeDigits)
	return []string{fitDisplayWidth(rendered, width)}
}

type markdownTable struct {
	Header []string
	Rows   [][]string
}

func parseMarkdownTable(lines []string) (markdownTable, int, bool) {
	if len(lines) < 2 {
		return markdownTable{}, 0, false
	}
	header, ok := parseMarkdownTableRow(lines[0])
	if !ok {
		return markdownTable{}, 0, false
	}
	if !isMarkdownTableSeparator(lines[1], len(header)) {
		return markdownTable{}, 0, false
	}

	rows := make([][]string, 0, len(lines)-2)
	consumed := 2
	for ; consumed < len(lines); consumed++ {
		trimmed := strings.TrimSpace(lines[consumed])
		if trimmed == "" {
			break
		}
		row, rowOK := parseMarkdownTableRow(lines[consumed])
		if !rowOK {
			break
		}
		rows = append(rows, normalizeMarkdownTableRow(row, len(header)))
	}

	return markdownTable{
		Header: normalizeMarkdownTableRow(header, len(header)),
		Rows:   rows,
	}, consumed, true
}

func parseMarkdownTableRow(line string) ([]string, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || !strings.Contains(trimmed, "|") {
		return nil, false
	}
	if len(trimmed) < 3 {
		return nil, false
	}
	inner := trimmed
	if len(trimmed) > 2 {
		inner = trimmed[1 : len(trimmed)-1]
	}
	if !strings.Contains(inner, "|") && !strings.HasPrefix(trimmed, "|") && !strings.HasSuffix(trimmed, "|") {
		return nil, false
	}

	if strings.HasPrefix(trimmed, "|") {
		trimmed = strings.TrimPrefix(trimmed, "|")
	}
	if strings.HasSuffix(trimmed, "|") {
		trimmed = strings.TrimSuffix(trimmed, "|")
	}

	parts := strings.Split(trimmed, "|")
	cells := make([]string, 0, len(parts))
	for _, part := range parts {
		cells = append(cells, strings.TrimSpace(part))
	}
	if len(cells) < 2 {
		return nil, false
	}
	return cells, true
}

func isMarkdownTableSeparator(line string, columns int) bool {
	row, ok := parseMarkdownTableRow(line)
	if !ok || len(row) != columns {
		return false
	}
	for _, cell := range row {
		trimmed := strings.TrimSpace(cell)
		if trimmed == "" {
			return false
		}
		for _, r := range trimmed {
			if r != '-' && r != ':' {
				return false
			}
		}
		if strings.Count(trimmed, "-") < 3 {
			return false
		}
	}
	return true
}

func normalizeMarkdownTableRow(row []string, columns int) []string {
	normalized := make([]string, columns)
	for index := 0; index < columns; index++ {
		if index < len(row) {
			normalized[index] = row[index]
		} else {
			normalized[index] = ""
		}
	}
	return normalized
}

func renderMarkdownTable(table markdownTable, width int, baseStyle lipgloss.Style) []string {
	columnCount := len(table.Header)
	if columnCount == 0 || width <= 0 {
		return []string{""}
	}

	allRows := make([][]string, 0, len(table.Rows)+1)
	allRows = append(allRows, table.Header)
	allRows = append(allRows, table.Rows...)

	plainWidths := make([]int, columnCount)
	for _, row := range allRows {
		for index, cell := range row {
			cellWidth := lipgloss.Width(strings.TrimSpace(cell))
			if cellWidth > plainWidths[index] {
				plainWidths[index] = cellWidth
			}
		}
	}

	available := maxInt(columnCount, width-(3*columnCount+1))
	columnWidths := allocateTableColumnWidths(plainWidths, available)

	lines := []string{
		renderMarkdownTableRule("┌", "┬", "┐", columnWidths),
	}
	lines = append(lines, renderMarkdownTableRowLines(table.Header, columnWidths, baseStyle.Copy().Bold(true))...)
	lines = append(lines,
		renderMarkdownTableRule("├", "┼", "┤", columnWidths),
	)

	for _, row := range table.Rows {
		lines = append(lines, renderMarkdownTableRowLines(row, columnWidths, baseStyle)...)
	}
	lines = append(lines, renderMarkdownTableRule("└", "┴", "┘", columnWidths))
	return lines
}

func allocateTableColumnWidths(naturalWidths []int, available int) []int {
	if len(naturalWidths) == 0 {
		return nil
	}

	widths := make([]int, len(naturalWidths))
	total := 0
	for index, value := range naturalWidths {
		widths[index] = maxInt(3, value)
		total += widths[index]
	}
	if total <= available {
		return widths
	}

	minTotal := len(widths) * 3
	if available <= minTotal {
		for index := range widths {
			widths[index] = 3
		}
		return widths
	}

	excess := total - available
	for excess > 0 {
		target := -1
		for index, current := range widths {
			if current <= 3 {
				continue
			}
			if target < 0 || current > widths[target] {
				target = index
			}
		}
		if target < 0 {
			break
		}
		widths[target]--
		excess--
	}
	return widths
}

func renderMarkdownTableRule(left, middle, right string, widths []int) string {
	parts := make([]string, 0, len(widths))
	for _, width := range widths {
		parts = append(parts, strings.Repeat("─", maxInt(1, width+2)))
	}
	return left + strings.Join(parts, middle) + right
}

func renderMarkdownTableRowLines(row []string, widths []int, style lipgloss.Style) []string {
	wrappedCells := make([][]string, len(widths))
	rowHeight := 1
	for index, width := range widths {
		value := ""
		if index < len(row) {
			value = strings.TrimSpace(row[index])
		}
		wrapped := wrapPlainText(value, maxInt(1, width))
		if len(wrapped) == 0 {
			wrapped = []string{""}
		}
		wrappedCells[index] = wrapped
		if len(wrapped) > rowHeight {
			rowHeight = len(wrapped)
		}
	}

	lines := make([]string, 0, rowHeight)
	for lineIndex := 0; lineIndex < rowHeight; lineIndex++ {
		cells := make([]string, 0, len(widths))
		for index, width := range widths {
			segment := ""
			if lineIndex < len(wrappedCells[index]) {
				segment = wrappedCells[index][lineIndex]
			}
			rendered := renderInlineMarkdown(segment, style)
			cells = append(cells, " "+fitDisplayWidth(rendered, width)+" ")
		}
		lines = append(lines, "│"+strings.Join(cells, "│")+"│")
	}
	return lines
}

func renderInlineMarkdown(value string, baseStyle lipgloss.Style) string {
	if !strings.ContainsAny(value, "`*_~[<!") && !strings.Contains(value, "](") {
		return baseStyle.Render(value)
	}

	var builder strings.Builder
	parts := strings.Split(value, "`")
	for index, part := range parts {
		if index%2 == 1 {
			builder.WriteString(inlineCodeStyle.Render(part))
			continue
		}
		builder.WriteString(renderInlineRichText(part, baseStyle))
	}
	return builder.String()
}

func renderInlineRichText(value string, baseStyle lipgloss.Style) string {
	if value == "" {
		return ""
	}

	runes := []rune(value)
	var builder strings.Builder
	for index := 0; index < len(runes); {
		switch {
		case runes[index] == '!' && index+1 < len(runes) && runes[index+1] == '[':
			if alt, target, nextIndex, ok := parseMarkdownLinkRunes(runes, index+1); ok {
				builder.WriteString(dimStyle.Render("[image] "))
				builder.WriteString(renderInlineEmphasis(alt, linkStyle.Copy()))
				if target != "" {
					builder.WriteString(dimStyle.Render(" <" + target + ">"))
				}
				index = nextIndex
				continue
			}
		case runes[index] == '[':
			if label, target, nextIndex, ok := parseMarkdownLinkRunes(runes, index); ok {
				builder.WriteString(renderInlineEmphasis(label, linkStyle.Copy()))
				if target != "" {
					builder.WriteString(dimStyle.Render(" <" + target + ">"))
				}
				index = nextIndex
				continue
			}
		case runes[index] == '<':
			if target, nextIndex, ok := parseAutoLinkRunes(runes, index); ok {
				builder.WriteString(linkStyle.Render(target))
				index = nextIndex
				continue
			}
			if nextIndex, ok := parseInlineHTMLTagRunes(runes, index); ok {
				index = nextIndex
				continue
			}
		}

		nextIndex := index + 1
		for nextIndex < len(runes) &&
			runes[nextIndex] != '[' &&
			runes[nextIndex] != '<' &&
			!(runes[nextIndex] == '!' && nextIndex+1 < len(runes) && runes[nextIndex+1] == '[') {
			nextIndex++
		}
		builder.WriteString(renderInlineEmphasis(string(runes[index:nextIndex]), baseStyle))
		index = nextIndex
	}
	return builder.String()
}

func renderInlineEmphasis(value string, baseStyle lipgloss.Style) string {
	return renderInlineStyled(value, baseStyle)
}

func findInlineMarkerEndRune(runes []rune, start int, marker rune) int {
	for index := start; index < len(runes); index++ {
		if runes[index] == marker {
			return index
		}
	}
	return -1
}

func findInlineMarkerEndString(runes []rune, start int, marker string) int {
	markerRunes := []rune(marker)
	for index := start; index+len(markerRunes) <= len(runes); index++ {
		matched := true
		for offset, r := range markerRunes {
			if runes[index+offset] != r {
				matched = false
				break
			}
		}
		if matched {
			return index
		}
	}
	return -1
}

func parseMarkdownLinkRunes(runes []rune, start int) (label string, target string, nextIndex int, ok bool) {
	if start < 0 || start >= len(runes) || runes[start] != '[' {
		return "", "", start, false
	}
	labelEnd := findInlineMarkerEndRune(runes, start+1, ']')
	if labelEnd < 0 || labelEnd+1 >= len(runes) || runes[labelEnd+1] != '(' {
		return "", "", start, false
	}
	targetEnd := findInlineMarkerEndRune(runes, labelEnd+2, ')')
	if targetEnd < 0 {
		return "", "", start, false
	}
	label = string(runes[start+1 : labelEnd])
	target = strings.TrimSpace(string(runes[labelEnd+2 : targetEnd]))
	return label, target, targetEnd + 1, true
}

func parseAutoLinkRunes(runes []rune, start int) (target string, nextIndex int, ok bool) {
	if start < 0 || start >= len(runes) || runes[start] != '<' {
		return "", start, false
	}
	end := findInlineMarkerEndRune(runes, start+1, '>')
	if end < 0 {
		return "", start, false
	}
	candidate := strings.TrimSpace(string(runes[start+1 : end]))
	parsed, err := url.Parse(candidate)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", start, false
	}
	return candidate, end + 1, true
}

func parseInlineHTMLTagRunes(runes []rune, start int) (nextIndex int, ok bool) {
	if start < 0 || start >= len(runes) || runes[start] != '<' {
		return start, false
	}
	end := findInlineMarkerEndRune(runes, start+1, '>')
	if end < 0 {
		return start, false
	}
	tag := strings.TrimSpace(string(runes[start+1 : end]))
	if tag == "" {
		return start, false
	}
	tag = strings.TrimPrefix(tag, "/")
	tag = strings.TrimPrefix(tag, "!")
	tag = strings.TrimPrefix(tag, "?")
	tag = strings.TrimSpace(tag)
	if tag == "" {
		return start, false
	}
	name := tag
	for index, r := range tag {
		if unicode.IsSpace(r) || r == '/' {
			name = tag[:index]
			break
		}
	}
	if name == "" {
		return start, false
	}
	for index, r := range name {
		if index == 0 {
			if !unicode.IsLetter(r) {
				return start, false
			}
			continue
		}
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '-' && r != ':' {
			return start, false
		}
	}
	return end + 1, true
}

func renderInlineStyled(value string, baseStyle lipgloss.Style) string {
	if value == "" {
		return ""
	}

	runes := []rune(value)
	var builder strings.Builder
	for index := 0; index < len(runes); {
		if runes[index] == '\\' && index+1 < len(runes) && isMarkdownEscapableRune(runes[index+1]) {
			builder.WriteString(baseStyle.Render(string(runes[index+1])))
			index += 2
			continue
		}

		if marker, end, ok := findInlineStyledMarker(runes, index); ok {
			inner := string(runes[index+len([]rune(marker)) : end])
			builder.WriteString(renderInlineStyled(inner, applyInlineMarkerStyle(baseStyle, marker)))
			index = end + len([]rune(marker))
			continue
		}

		builder.WriteString(baseStyle.Render(string(runes[index])))
		index++
	}
	return builder.String()
}

func findInlineStyledMarker(runes []rune, start int) (marker string, end int, ok bool) {
	markers := []string{"***", "___", "**", "__", "~~", "*", "_"}
	for _, marker := range markers {
		if hasRunePrefixAt(runes, start, marker) {
			if !isValidInlineStyleDelimiter(runes, start, marker) {
				continue
			}
			end := findInlineClosingMarker(runes, start+len([]rune(marker)), marker)
			if end >= 0 {
				return marker, end, true
			}
		}
	}
	return "", -1, false
}

func hasRunePrefixAt(runes []rune, start int, marker string) bool {
	markerRunes := []rune(marker)
	if start < 0 || start+len(markerRunes) > len(runes) {
		return false
	}
	for offset, r := range markerRunes {
		if runes[start+offset] != r {
			return false
		}
	}
	return true
}

func findInlineClosingMarker(runes []rune, start int, marker string) int {
	markerRunes := []rune(marker)
	for index := start; index+len(markerRunes) <= len(runes); index++ {
		if index > 0 && runes[index-1] == '\\' {
			continue
		}
		if hasRunePrefixAt(runes, index, marker) {
			if !isValidInlineStyleDelimiter(runes, index, marker) {
				continue
			}
			return index
		}
	}
	return -1
}

func isValidInlineStyleDelimiter(runes []rune, start int, marker string) bool {
	if marker == "" || marker[0] != '_' {
		return true
	}
	markerWidth := len([]rune(marker))
	beforeIsWord := start > 0 && isMarkdownWordRune(runes[start-1])
	afterIndex := start + markerWidth
	afterIsWord := afterIndex < len(runes) && isMarkdownWordRune(runes[afterIndex])
	return !(beforeIsWord && afterIsWord)
}

func isMarkdownWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

func applyInlineMarkerStyle(baseStyle lipgloss.Style, marker string) lipgloss.Style {
	style := baseStyle.Copy()
	switch marker {
	case "***", "___":
		return style.Bold(true).Italic(true)
	case "**", "__":
		return style.Bold(true)
	case "*", "_":
		return style.Italic(true)
	case "~~":
		return style.Strikethrough(true)
	default:
		return style
	}
}

func isMarkdownEscapableRune(r rune) bool {
	return strings.ContainsRune(`\`+"`*_{}[]()#+-.!~<>", r)
}

func renderDiffRows(sign, lineNumber, content string, width int) []string {
	signStyle := diffAddGutterStyle
	lineStyle := diffAddLineStyle
	if sign == "-" {
		signStyle = diffRemoveGutterStyle
		lineStyle = diffRemoveLineStyle
	}
	plainPrefix := diffPlainGutter(sign, lineNumber)
	prefix := renderDiffGutter(sign, lineNumber, signStyle)
	if content == "" {
		return []string{prefix + renderDiffCodeSegment("", width-lipgloss.Width(plainPrefix)-1, lineStyle)}
	}

	contentWidth := maxInt(8, width-lipgloss.Width(plainPrefix)-1)
	wrapped := wrapPlainText(content, contentWidth)
	lines := make([]string, 0, len(wrapped))
	for index, row := range wrapped {
		rowPrefix := prefix
		if index > 0 {
			rowPrefix = renderDiffContinuationGutter(sign, plainPrefix)
		}
		lines = append(lines, rowPrefix+renderDiffCodeSegment(row, contentWidth, lineStyle))
	}
	return lines
}

func renderCodeLine(value string) string {
	return renderCodeLineWithPalette(value, defaultCodePalette())
}

func renderCodeLineWithPalette(value string, palette codePalette) string {
	if strings.TrimSpace(value) == "" {
		return palette.Plain.Render(value)
	}

	commentIndex := findCommentIndex(value)
	codePart := value
	commentPart := ""
	if commentIndex >= 0 {
		codePart = value[:commentIndex]
		commentPart = value[commentIndex:]
	}

	var builder strings.Builder
	tokens := tokenizeCode(codePart)
	for _, token := range tokens {
		builder.WriteString(renderCodeTokenWithPalette(token, palette))
	}
	if commentPart != "" {
		builder.WriteString(palette.Comment.Render(commentPart))
	}
	return builder.String()
}

func findCommentIndex(value string) int {
	inSingle := false
	inDouble := false
	inBacktick := false
	for index, r := range value {
		switch r {
		case '\'':
			if !inDouble && !inBacktick {
				inSingle = !inSingle
			}
		case '"':
			if !inSingle && !inBacktick {
				inDouble = !inDouble
			}
		case '`':
			if !inSingle && !inDouble {
				inBacktick = !inBacktick
			}
		case '#':
			if !inSingle && !inDouble && !inBacktick {
				return index
			}
		}
	}
	commentSlash := strings.Index(value, "//")
	if commentSlash >= 0 && !inSingle && !inDouble && !inBacktick {
		return commentSlash
	}
	return -1
}

func tokenizeCode(value string) []string {
	if value == "" {
		return nil
	}
	tokens := make([]string, 0, len(value))
	runes := []rune(value)
	for index := 0; index < len(runes); {
		current := runes[index]
		switch {
		case current == '"' || current == '\'' || current == '`':
			quote := current
			end := index + 1
			for end < len(runes) {
				if runes[end] == quote && runes[end-1] != '\\' {
					end++
					break
				}
				end++
			}
			tokens = append(tokens, string(runes[index:minInt(end, len(runes))]))
			index = end
		case current == '_' || current >= 'A' && current <= 'Z' || current >= 'a' && current <= 'z':
			end := index + 1
			for end < len(runes) {
				next := runes[end]
				if !(next == '_' || next >= 'A' && next <= 'Z' || next >= 'a' && next <= 'z' || next >= '0' && next <= '9') {
					break
				}
				end++
			}
			tokens = append(tokens, string(runes[index:end]))
			index = end
		case current >= '0' && current <= '9':
			end := scanCodeNumericToken(runes, index)
			if end <= index {
				end = index + 1
			}
			tokens = append(tokens, string(runes[index:end]))
			index = end
		default:
			tokens = append(tokens, string(current))
			index++
		}
	}
	return tokens
}

func renderCodeToken(token string) string {
	return renderCodeTokenWithPalette(token, defaultCodePalette())
}

func renderCodeTokenWithPalette(token string, palette codePalette) string {
	trimmed := strings.TrimSpace(token)
	switch {
	case trimmed == "":
		return palette.Plain.Render(token)
	case isQuotedCodeToken(token):
		return palette.String.Render(token)
	case isCodeKeyword(trimmed):
		return palette.Keyword.Render(token)
	case isCodeTypeToken(trimmed):
		return palette.Type.Render(token)
	case isCodeBuiltinToken(trimmed):
		return palette.Builtin.Render(token)
	case isNumericToken(trimmed):
		return palette.Number.Render(token)
	default:
		return palette.Plain.Render(token)
	}
}

type codePalette struct {
	Keyword lipgloss.Style
	String  lipgloss.Style
	Comment lipgloss.Style
	Number  lipgloss.Style
	Type    lipgloss.Style
	Builtin lipgloss.Style
	Plain   lipgloss.Style
}

func defaultCodePalette() codePalette {
	return codePalette{
		Keyword: codeKeywordStyle,
		String:  codeStringStyle,
		Comment: codeCommentStyle,
		Number:  codeNumberStyle,
		Type:    codeTypeStyle,
		Builtin: codeBuiltinStyle,
		Plain:   codePlainStyle,
	}
}

func diffCodePalette(lineStyle lipgloss.Style) codePalette {
	background := lipgloss.Color("#103B2A")
	plain := lipgloss.Color("#E6EDF3")
	keyword := lipgloss.Color("#FF9B9B")
	stringColor := lipgloss.Color("#A5D6FF")
	comment := lipgloss.Color("#8B949E")
	number := lipgloss.Color("#79C0FF")
	typeColor := lipgloss.Color("#D2A8FF")
	builtin := lipgloss.Color("#FFB86B")
	if bg := lineStyle.GetBackground(); bg != nil {
		if color, ok := bg.(lipgloss.Color); ok {
			background = color
		}
	}
	if background == lipgloss.Color("#5D1E27") {
		plain = lipgloss.Color("#F0D7DA")
		keyword = lipgloss.Color("#FFB3BA")
		stringColor = lipgloss.Color("#FFD8A8")
		comment = lipgloss.Color("#C9A7AD")
		number = lipgloss.Color("#A5D6FF")
		typeColor = lipgloss.Color("#E2C5FF")
		builtin = lipgloss.Color("#FFD29D")
	}
	return codePalette{
		Keyword: lipgloss.NewStyle().Foreground(keyword).Background(background).Bold(true),
		String:  lipgloss.NewStyle().Foreground(stringColor).Background(background),
		Comment: lipgloss.NewStyle().Foreground(comment).Background(background).Italic(true),
		Number:  lipgloss.NewStyle().Foreground(number).Background(background),
		Type:    lipgloss.NewStyle().Foreground(typeColor).Background(background),
		Builtin: lipgloss.NewStyle().Foreground(builtin).Background(background),
		Plain:   lipgloss.NewStyle().Foreground(plain).Background(background),
	}
}

func diffPlainGutter(sign, lineNumber string) string {
	if strings.TrimSpace(lineNumber) == "" {
		return sign
	}
	return fmt.Sprintf("%s %4s │", sign, lineNumber)
}

func renderDiffGutter(sign, lineNumber string, signStyle lipgloss.Style) string {
	plain := diffPlainGutter(sign, lineNumber)
	switch sign {
	case "+":
		return diffAddANSIStart + plain + diffANSIEnd
	case "-":
		return diffRemoveANSIStart + plain + diffANSIEnd
	default:
		renderedSign := signStyle.Copy().
			Background(lipgloss.Color("#FFFFFF")).
			Render(sign)
		if strings.TrimSpace(lineNumber) == "" {
			return renderedSign
		}
		return renderedSign + diffGutterBaseStyle.Render(" "+fmt.Sprintf("%4s │", lineNumber))
	}
}

func renderDiffContinuationGutter(sign, plain string) string {
	if plain == "" {
		return ""
	}
	switch sign {
	case "+":
		return diffAddANSIStart + strings.Repeat(" ", lipgloss.Width(plain)) + diffANSIEnd
	case "-":
		return diffRemoveANSIStart + strings.Repeat(" ", lipgloss.Width(plain)) + diffANSIEnd
	}
	return diffGutterBaseStyle.Render(strings.Repeat(" ", lipgloss.Width(plain)))
}

func renderDiffCodeSegment(value string, width int, lineStyle lipgloss.Style) string {
	segmentWidth := maxInt(1, width+1)
	if strings.TrimSpace(value) == "" {
		return lineStyle.Render(strings.Repeat(" ", segmentWidth))
	}

	renderedCode := renderCodeLineWithPalette(value, diffCodePalette(lineStyle))
	maxCodeWidth := maxInt(0, segmentWidth-1)
	if displayWidth(renderedCode) > maxCodeWidth {
		renderedCode = truncateDisplayWidth(renderedCode, maxCodeWidth, "")
	}
	padding := maxInt(0, maxCodeWidth-displayWidth(renderedCode))
	return lineStyle.Render(" ") + renderedCode + lineStyle.Render(strings.Repeat(" ", padding))
}

func isQuotedCodeToken(token string) bool {
	if len(token) < 2 {
		return false
	}
	return (strings.HasPrefix(token, "\"") && strings.HasSuffix(token, "\"")) ||
		(strings.HasPrefix(token, "'") && strings.HasSuffix(token, "'")) ||
		(strings.HasPrefix(token, "`") && strings.HasSuffix(token, "`"))
}

func isCodeKeyword(token string) bool {
	switch token {
	case "def", "class", "return", "if", "elif", "else", "for", "while", "in", "import", "from",
		"try", "except", "finally", "raise", "with", "as", "lambda", "pass", "break", "continue",
		"True", "False", "None", "and", "or", "not", "async", "await", "yield",
		"func", "package", "type", "struct", "interface", "switch", "case",
		"default", "go", "defer", "const", "var", "map", "range", "chan", "select", "fallthrough",
		"let", "function", "export", "extends", "implements", "new", "null", "undefined",
		"static", "public", "private", "protected", "readonly", "this", "super", "throw":
		return true
	default:
		return false
	}
}

func isCodeTypeToken(token string) bool {
	switch token {
	case "string", "number", "boolean", "object", "void", "any", "unknown", "never",
		"int", "int32", "int64", "float32", "float64", "byte", "rune", "error",
		"Promise", "Record", "Array", "Map", "Set":
		return true
	default:
		return false
	}
}

func isCodeBuiltinToken(token string) bool {
	switch token {
	case "console", "JSON", "Math", "Date", "Error", "Object", "String", "Number", "Boolean",
		"parseInt", "parseFloat", "require", "module", "exports", "print", "fmt", "len", "cap",
		"append", "make", "panic", "recover":
		return true
	default:
		return false
	}
}

func isNumericToken(token string) bool {
	if token == "" {
		return false
	}
	return scanCodeNumericToken([]rune(token), 0) == len([]rune(token))
}

func scanCodeNumericToken(runes []rune, start int) int {
	if start < 0 || start >= len(runes) || runes[start] < '0' || runes[start] > '9' {
		return start
	}

	if start+1 < len(runes) && runes[start] == '0' {
		switch runes[start+1] {
		case 'x', 'X':
			return scanCodeRadixNumericToken(runes, start, 2, isHexDigit)
		case 'b', 'B':
			return scanCodeRadixNumericToken(runes, start, 2, func(r rune) bool { return r == '0' || r == '1' })
		case 'o', 'O':
			return scanCodeRadixNumericToken(runes, start, 2, func(r rune) bool { return r >= '0' && r <= '7' })
		}
	}

	index := start
	index = scanCodeDigitsWithSeparators(runes, index, func(r rune) bool { return r >= '0' && r <= '9' })

	if index < len(runes) && runes[index] == '.' {
		next := index + 1
		if next < len(runes) && ((runes[next] >= '0' && runes[next] <= '9') || runes[next] == '_') {
			index = next
			index = scanCodeDigitsWithSeparators(runes, index, func(r rune) bool { return r >= '0' && r <= '9' })
		}
	}

	if index < len(runes) && (runes[index] == 'e' || runes[index] == 'E') {
		expStart := index
		next := index + 1
		if next < len(runes) && (runes[next] == '+' || runes[next] == '-') {
			next++
		}
		expEnd := scanCodeDigitsWithSeparators(runes, next, func(r rune) bool { return r >= '0' && r <= '9' })
		if expEnd > next {
			index = expEnd
		} else {
			index = expStart
		}
	}

	return index
}

func scanCodeRadixNumericToken(runes []rune, start, prefixLen int, isDigit func(rune) bool) int {
	index := start + prefixLen
	end := scanCodeDigitsWithSeparators(runes, index, isDigit)
	if end == index {
		return start + 1
	}
	return end
}

func scanCodeDigitsWithSeparators(runes []rune, start int, isDigit func(rune) bool) int {
	index := start
	seenDigit := false
	lastWasSeparator := false
	for index < len(runes) {
		switch r := runes[index]; {
		case isDigit(r):
			seenDigit = true
			lastWasSeparator = false
			index++
		case r == '_' && seenDigit && !lastWasSeparator && index+1 < len(runes) && isDigit(runes[index+1]):
			lastWasSeparator = true
			index++
		default:
			if lastWasSeparator {
				return index - 1
			}
			return index
		}
	}
	if lastWasSeparator {
		return index - 1
	}
	return index
}

func isHexDigit(r rune) bool {
	return (r >= '0' && r <= '9') ||
		(r >= 'a' && r <= 'f') ||
		(r >= 'A' && r <= 'F')
}

func (m *Model) renderActivePanel(width, height int) string {
	switch m.ActivePanel {
	case PanelApprovals:
		return m.renderApprovals(width, height)
	case PanelPlans:
		return m.renderPlans(width, height)
	case PanelSessions:
		return m.renderSessions(width, height)
	case PanelModels:
		return m.renderModels(width, height)
	case PanelProviders:
		return m.renderProviders(width, height)
	case PanelAuth:
		return m.renderAuthPanel(width, height)
	default:
		return ""
	}
}

func (m *Model) renderStatusLine(width int) string {
	return ""
}

func composerPlaceholder(panel Panel) string {
	if panel != PanelNone {
		return fmt.Sprintf("Panel %s active. Esc to close, then continue typing.", panel)
	}
	return "Ask Cyrene, add images with Ctrl+O, use / commands, or mention files with @..."
}

type attachmentBarSegment struct {
	Kind  string
	Index int
	Start int
	End   int
	Text  string
}

type attachmentBarLine struct {
	Text     string
	Segments []attachmentBarSegment
}

func (m *Model) composerAttachmentBarLine(width int) attachmentBarLine {
	segments := make([]attachmentBarSegment, 0, len(m.Attachments))
	column := 0
	appendSegment := func(kind string, index int, text string) {
		if len(segments) > 0 {
			column++
		}
		start := column
		column += lipgloss.Width(text)
		segments = append(segments, attachmentBarSegment{
			Kind:  kind,
			Index: index,
			Start: start,
			End:   column,
			Text:  text,
		})
	}

	for index, attachment := range m.Attachments {
		name := strings.TrimSpace(attachment.Name)
		if name == "" {
			name = filepath.Base(strings.TrimSpace(attachment.Path))
		}
		chip := fmt.Sprintf("[img %s x]", truncatePlain(name, maxInt(8, minInt(18, maxInt(8, width/5)))))
		appendSegment("attachment", index, chip)
	}

	plain := make([]string, 0, len(segments))
	for _, segment := range segments {
		plain = append(plain, segment.Text)
	}
	return attachmentBarLine{
		Text:     strings.Join(plain, " "),
		Segments: segments,
	}
}

func (m *Model) renderComposerAttachmentBar(width int) []string {
	line := m.composerAttachmentBarLine(width)
	if len(line.Segments) == 0 {
		return nil
	}
	rendered := make([]string, 0, len(line.Segments))
	for _, segment := range line.Segments {
		switch segment.Kind {
		case "attachment":
			rendered = append(rendered, attachmentChipStyle.Render(segment.Text))
		}
	}
	return []string{strings.Join(rendered, " ")}
}

func (m *Model) renderAttachmentInputLine() string {
	value := string(m.AttachmentInput)
	if value == "" {
		value = "Paste or type an image path"
	}
	body := value
	if m.AttachmentInputActive {
		cursor := clampInt(m.AttachmentCursor, 0, len(m.AttachmentInput))
		before := string(m.AttachmentInput[:cursor])
		after := string(m.AttachmentInput[cursor:])
		if len(m.AttachmentInput) == 0 {
			body = composerCursorGlyph + "Paste or type an image path"
		} else {
			body = before + composerCursorGlyph + after
		}
	}
	prefix := attachmentAddStyle.Render("img> ")
	if len(m.AttachmentInput) == 0 {
		return prefix + dimStyle.Render(body)
	}
	return prefix + body
}

func (m *Model) renderComposer(width int) string {
	promptStyle := promptStyleForStatus(m.Status).
		Background(uiComposerSurfaceColor).
		ColorWhitespace(true)
	style := focusedInputBoxStyle
	if m.ActivePanel != PanelNone {
		style = inputBoxStyle
	}
	railWidth := composerRailWidth(m.ActivePanel)
	innerWidth := maxInt(1, width-railWidth)
	contentWidth := framedInnerWidth(style, innerWidth)

	lines := make([]string, 0, 8)
	if m.Notice != "" {
		noticeStyle := dimStyle
		if m.NoticeIsError {
			noticeStyle = errorStyle
		}
		for _, line := range wrapPlainText(m.Notice, contentWidth) {
			lines = append(lines, noticeStyle.Render(line))
		}
	}

	if matches := m.composerSlashSuggestionsForDisplay(slashSuggestionLimit); len(matches) > 0 && strings.HasPrefix(strings.TrimSpace(string(m.Input)), "/") {
		lines = append(lines, renderSlashSuggestionBlock(matches, contentWidth, m.SlashSelection)...)
	}

	lines = append(lines, m.renderComposerAttachmentBar(contentWidth)...)
	if m.AttachmentInputActive {
		lines = append(lines, m.renderAttachmentInputLine())
	}

	rows := m.visibleComposerRows(contentWidth)
	inputLines := make([]string, 0, composerMinInputRows)
	for index := 0; index < composerInputTopPadding(len(rows), m.shouldCenterComposerPlaceholder()); index++ {
		inputLines = append(inputLines, renderComposerBlankInputRow(contentWidth))
	}
	for _, row := range rows {
		prefix := "❯ "
		if row.Continued {
			prefix = "  "
		}

		if row.Placeholder {
			placeholder := truncatePlain(row.Text, maxInt(1, contentWidth-displayWidth(prefix)))
			inputLines = append(inputLines, promptStyle.Render(prefix)+composerPlaceholderStyle.Render(placeholder))
			continue
		}
		prefixStyle := promptStyle
		if row.Continued {
			prefixStyle = composerContinuationStyle
		}
		inputLines = append(inputLines, prefixStyle.Render(prefix)+row.Text)
	}
	for len(inputLines) < composerMinInputRows {
		inputLines = append(inputLines, renderComposerBlankInputRow(contentWidth))
	}
	lines = append(lines, inputLines...)

	body := style.
		Width(framedRenderWidth(style, innerWidth)).
		MaxWidth(innerWidth).
		Render(strings.Join(lines, "\n"))
	return renderComposerRail(body, width, m.ActivePanel)
}

func composerRailWidth(activePanel Panel) int {
	if activePanel != PanelNone {
		return 0
	}
	return lipgloss.Width(composerFocusRailGlyph)
}

func renderComposerRail(body string, width int, activePanel Panel) string {
	if activePanel != PanelNone {
		return body
	}
	bodyWidth := maxInt(1, width-lipgloss.Width(composerFocusRailGlyph))
	rail := composerFocusAccentStyle.Render(composerFocusRailGlyph)
	lines := strings.Split(body, "\n")
	for index, line := range lines {
		lines[index] = rail + fitDisplayWidth(line, bodyWidth)
	}
	return strings.Join(lines, "\n")
}

func (m *Model) shouldCenterComposerPlaceholder() bool {
	return len(m.Input) == 0 && len(m.Composition) == 0
}

func composerInputTopPadding(rowCount int, center bool) int {
	if center && rowCount > 0 && rowCount < composerMinInputRows {
		return 1
	}
	return 0
}

func renderComposerBlankInputRow(width int) string {
	prefixWidth := minInt(2, maxInt(0, width))
	bodyWidth := maxInt(0, width-prefixWidth)
	return composerContinuationStyle.Render(strings.Repeat(" ", prefixWidth)) +
		composerTextStyle.Render(strings.Repeat(" ", bodyWidth))
}

func (m *Model) renderComposerTextarea(width int, promptStyle lipgloss.Style) []string {
	placeholder := composerPlaceholder(m.ActivePanel)

	rowCount := len(m.visibleComposerRows(width))
	m.configureComposerTextarea(width, rowCount, promptStyle, placeholder)
	m.syncComposerTextareaValue()

	rendered := strings.TrimRight(m.Composer.View(), "\n")
	if rendered == "" {
		return []string{""}
	}
	return strings.Split(rendered, "\n")
}

func (m *Model) updateTerminalCursorAnchor(width, composerHeight, bottomDividerHeight, footerHeight int) {
	line, column, ok := m.composerCursorAnchorInComposer(width)
	if !ok || composerHeight <= 0 {
		m.setTerminalCursorAnchor(TerminalCursorAnchor{})
		return
	}
	line = clampInt(line, 0, maxInt(0, composerHeight-1))
	m.setTerminalCursorAnchor(TerminalCursorAnchor{
		Active:       true,
		RowsUp:       maxInt(0, composerHeight-1-line) + maxInt(0, bottomDividerHeight) + maxInt(0, footerHeight),
		ColumnsRight: maxInt(0, column),
	})
}

func (m *Model) composerCursorAnchorInComposer(width int) (int, int, bool) {
	if m.ActivePanel != PanelNone {
		return 0, 0, false
	}

	railWidth := composerRailWidth(m.ActivePanel)
	contentWidth := maxInt(1, width-railWidth)
	prefixLines := 0
	if m.Notice != "" {
		prefixLines += len(wrapPlainText(m.Notice, contentWidth))
	}
	if matches := m.composerSlashSuggestionsForDisplay(slashSuggestionLimit); len(matches) > 0 && strings.HasPrefix(strings.TrimSpace(string(m.Input)), "/") {
		prefixLines += len(renderSlashSuggestionBlock(matches, contentWidth, m.SlashSelection))
	}
	prefixLines += len(m.renderComposerAttachmentBar(contentWidth))

	if m.AttachmentInputActive {
		paddingLeft := focusedInputBoxStyle.GetPaddingLeft()
		prefixWidth := lipgloss.Width("img> ")
		return prefixLines, railWidth + paddingLeft + prefixWidth + lipgloss.Width(string(m.AttachmentInput[:clampInt(m.AttachmentCursor, 0, len(m.AttachmentInput))])), true
	}

	prefixLines += composerInputTopPadding(len(m.visibleComposerRows(contentWidth)), m.shouldCenterComposerPlaceholder())
	row, col, ok := m.composerInputCursorPosition(contentWidth)
	if !ok {
		return 0, 0, false
	}

	paddingLeft := focusedInputBoxStyle.GetPaddingLeft()
	prefixWidth := lipgloss.Width("❯ ")
	return prefixLines + row, railWidth + paddingLeft + prefixWidth + col, true
}

func (m *Model) composerInputCursorPosition(width int) (int, int, bool) {
	inputWidth := maxInt(1, width-2)
	cursor := clampInt(m.Cursor, 0, len(m.Input))
	compositionCursor := clampInt(m.CompositionCursor, 0, len(m.Composition))
	row, col := 0, 0

	advance := func(values []rune) {
		for _, value := range values {
			if value == '\n' {
				row++
				col = 0
				continue
			}
			cellWidth := lipgloss.Width(string(value))
			if col > 0 && col+cellWidth > inputWidth {
				row++
				col = 0
			}
			col += cellWidth
		}
	}

	advance(m.Input[:cursor])
	if len(m.Composition) > 0 && compositionCursor > 0 {
		advance(m.Composition[:compositionCursor])
	}

	cursorRow, cursorCol := row, col

	advance([]rune(composerCursorGlyph))
	if len(m.Composition) > 0 && compositionCursor < len(m.Composition) {
		advance(m.Composition[compositionCursor:])
	}
	if cursor < len(m.Input) {
		advance(m.Input[cursor:])
	}

	totalRows := row + 1
	firstVisibleRow := clampInt(cursorRow-2, 0, maxInt(0, totalRows-composerVisibleRowLimit))
	visibleCursorRow := cursorRow - firstVisibleRow
	if visibleCursorRow < 0 || visibleCursorRow >= composerVisibleRowLimit {
		return 0, 0, false
	}
	return visibleCursorRow, cursorCol, true
}

func renderComposerTopDivider(width int) string {
	return ""
}

func renderComposerBottomDivider(width int) string {
	return ""
}

func slashAlternateSummary(item slashCommandSpec) string {
	command := strings.TrimSpace(item.Command)
	description := strings.TrimSpace(item.Description)
	if description == "" {
		return command
	}
	description = strings.ReplaceAll(description, "  |  ", " | ")
	description = strings.ReplaceAll(description, "  ", " ")
	return fmt.Sprintf("%s  %s", command, description)
}

type composerRow struct {
	Text        string
	Placeholder bool
	Continued   bool
}

const composerCursorRune = '█'
const composerCursorGlyph = string(composerCursorRune)

func (m *Model) visibleComposerRows(width int) []composerRow {
	if len(m.Input) == 0 && len(m.Composition) == 0 {
		placeholder := composerPlaceholder(m.ActivePanel)
		return []composerRow{{
			Text:        placeholder,
			Placeholder: true,
		}}
	}

	rows := renderComposerSegments(m.composerDisplaySegments(), maxInt(1, width-2))
	if len(rows) <= composerVisibleRowLimit {
		return rows
	}
	cursorRow := 0
	for index, row := range rows {
		if strings.Contains(row.Text, composerCursorGlyph) {
			cursorRow = index
			break
		}
	}
	start := clampInt(cursorRow-2, 0, maxInt(0, len(rows)-composerVisibleRowLimit))
	return rows[start : start+composerVisibleRowLimit]
}

type composerSegment struct {
	Text string
	Kind string
}

func (m *Model) composerDisplaySegments() []composerSegment {
	cursor := clampInt(m.Cursor, 0, len(m.Input))
	compositionCursor := clampInt(m.CompositionCursor, 0, len(m.Composition))
	segments := make([]composerSegment, 0, 8)
	if cursor > 0 {
		segments = append(segments, collapseComposerDisplayText(string(m.Input[:cursor]), "plain")...)
	}
	if len(m.Composition) > 0 {
		if compositionCursor > 0 {
			segments = append(segments, collapseComposerDisplayText(string(m.Composition[:compositionCursor]), "composition")...)
		}
		segments = append(segments, composerSegment{Text: composerCursorGlyph, Kind: "cursor"})
		if compositionCursor < len(m.Composition) {
			segments = append(segments, collapseComposerDisplayText(string(m.Composition[compositionCursor:]), "composition")...)
		}
	} else {
		segments = append(segments, composerSegment{Text: composerCursorGlyph, Kind: "cursor"})
	}
	if cursor < len(m.Input) {
		segments = append(segments, collapseComposerDisplayText(string(m.Input[cursor:]), "plain")...)
	}
	return segments
}

func collapseComposerDisplayText(text string, kind string) []composerSegment {
	if text == "" {
		return nil
	}
	if kind != "collapsed" {
		if segments := splitComposerPasteSummarySegments(text, kind); len(segments) > 0 {
			return segments
		}
	}
	return []composerSegment{{Text: text, Kind: kind}}
}

func splitComposerPasteSummarySegments(text string, kind string) []composerSegment {
	indices := composerPasteSummaryPattern.FindAllStringIndex(text, -1)
	if len(indices) == 0 {
		return nil
	}

	segments := make([]composerSegment, 0, len(indices)*2+1)
	start := 0
	for _, index := range indices {
		if index[0] > start {
			segments = append(segments, composerSegment{Text: text[start:index[0]], Kind: kind})
		}
		segments = append(segments, composerSegment{Text: text[index[0]:index[1]], Kind: "collapsed"})
		start = index[1]
	}
	if start < len(text) {
		segments = append(segments, composerSegment{Text: text[start:], Kind: kind})
	}
	return segments
}

func renderComposerSegments(segments []composerSegment, width int) []composerRow {
	if width <= 0 {
		return []composerRow{{Text: ""}}
	}

	rows := make([]composerRow, 0, 2)
	var current strings.Builder
	var chunk strings.Builder
	currentWidth := 0
	continued := false
	chunkKind := ""

	flushChunk := func() {
		if chunk.Len() == 0 {
			return
		}
		current.WriteString(renderComposerChunk(chunk.String(), chunkKind))
		chunk.Reset()
		chunkKind = ""
	}

	flush := func() {
		flushChunk()
		rows = append(rows, composerRow{Text: current.String(), Continued: continued})
		current.Reset()
		currentWidth = 0
		continued = true
	}

	appendSegment := func(text string, kind string) {
		for _, r := range text {
			if r == '\n' {
				flush()
				continue
			}
			cellWidth := lipgloss.Width(string(r))
			if currentWidth > 0 && currentWidth+cellWidth > width {
				flush()
			}

			if chunk.Len() > 0 && chunkKind != kind {
				flushChunk()
			}
			if chunkKind == "" {
				chunkKind = kind
			}
			chunk.WriteRune(r)
			currentWidth += cellWidth
		}
	}

	for _, segment := range segments {
		appendSegment(segment.Text, segment.Kind)
	}
	flushChunk()
	if current.Len() > 0 || len(rows) == 0 {
		rows = append(rows, composerRow{Text: current.String(), Continued: continued})
	}
	return rows
}

func renderComposerChunk(text string, kind string) string {
	switch kind {
	case "cursor":
		return composerCursorStyle.Render(text)
	case "composition":
		return compositionStyle.Render(text)
	case "collapsed":
		return collapsedPasteStyle.Render(text)
	default:
		return composerTextStyle.Render(text)
	}
}

func renderSlashSuggestionBlock(items []slashCommandSpec, width int, selected int) []string {
	if len(items) == 0 || width <= 0 {
		return nil
	}

	maxCommandWidth := 0
	for _, item := range items {
		maxCommandWidth = maxInt(maxCommandWidth, lipgloss.Width(strings.TrimSpace(slashDisplayCommand(item))))
	}
	commandWidth := clampInt(maxCommandWidth, 18, minInt(30, maxInt(18, width/3)))
	descriptionWidth := maxInt(1, width-commandWidth-2)
	lines := make([]string, 0, len(items)*2)
	for itemIndex, item := range items {
		command := truncatePlain(slashDisplayCommand(item), commandWidth)
		descriptionRows := wrapPlainText(strings.TrimSpace(item.Description), descriptionWidth)
		if len(descriptionRows) == 0 {
			descriptionRows = []string{""}
		}

		padding := strings.Repeat(" ", maxInt(1, commandWidth-lipgloss.Width(command)+1))
		firstLinePlain := " " + command + padding + descriptionRows[0]
		if itemIndex == selected && selected >= 0 {
			lines = append(lines, renderSelectedSlashLine(firstLinePlain, width))
		} else {
			lines = append(lines, fitDisplayWidth(firstLinePlain, width))
		}
		for _, row := range descriptionRows[1:] {
			plain := " " + strings.Repeat(" ", commandWidth+1) + row
			if itemIndex == selected && selected >= 0 {
				lines = append(lines, renderSelectedSlashLine(plain, width))
				continue
			}
			lines = append(lines, fitDisplayWidth(plain, width))
		}
	}
	return lines
}

func renderSelectedSlashLine(text string, width int) string {
	if width <= 0 {
		return ""
	}
	return selectedSlashStyle.
		Width(width).
		MaxWidth(width).
		Render(fitDisplayWidth(text, width))
}

func slashDisplayCommand(item slashCommandSpec) string {
	command := strings.TrimSpace(item.Command)
	if strings.HasPrefix(command, "/") {
		if compact := compactSlashCommand(command); compact != "" {
			return compact
		}
	}
	return command
}

func (m *Model) renderApprovals(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	page := pageForSelection(len(m.PendingReviews), m.ApprovalIndex, approvalQueuePageSize)
	headerLines := []string{
		renderPanelHeaderColumns(bodyWidth, "sel ↑/↓", "page ←/→", "mode tab", "j/k prev", "approve a", "reject r", "esc"),
	}
	footerLines := []string{renderPanelSummaryColumns(bodyWidth, "approvals", fmt.Sprintf("page %d/%d", page.CurrentPage, page.TotalPages), fmt.Sprintf("total %d", page.Total))}
	bodyLines := []string{}

	if len(m.PendingReviews) == 0 {
		bodyLines = append(bodyLines, dimStyle.Render("No pending approvals."))
		return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
	}

	selected := m.PendingReviews[m.ApprovalIndex]
	bodyLines = append(bodyLines, sectionStyle.Render("queue"))
	for index := page.Start; index < page.End; index++ {
		item := m.PendingReviews[index]
		prefix := "  "
		lineStyle := lipgloss.NewStyle()
		if index == m.ApprovalIndex {
			prefix = "> "
			lineStyle = asstStyle.Bold(true)
		}
		line := fmt.Sprintf("%s%s  %s", prefix, actionBadge(item.Action), truncatePlain(item.Path, maxInt(10, bodyWidth-20)))
		bodyLines = append(bodyLines, lineStyle.Render(line))
	}

	bodyLines = append(bodyLines, sectionStyle.Render("detail"))
	bodyLines = append(bodyLines, approvalDetailBannerStyle.Render(truncatePlain(fmt.Sprintf("%s  %s", actionBadge(selected.Action), selected.Path), bodyWidth)))
	bodyLines = append(bodyLines, renderApprovalMetaRow("kind", describeApprovalAction(selected.Action), bodyWidth))
	bodyLines = append(bodyLines, renderApprovalMetaRow("path", selected.Path, bodyWidth))
	bodyLines = append(bodyLines, renderApprovalMetaRow("id", truncatePlain(selected.ID, maxInt(12, bodyWidth-8)), bodyWidth))
	bodyLines = append(bodyLines, renderApprovalMetaRow("created", emptyFallback(selected.CreatedAt, "unknown"), bodyWidth))
	previewSource := selected.PreviewSummary
	if m.ApprovalPreview == ApprovalFull && strings.TrimSpace(selected.PreviewFull) != "" {
		previewSource = selected.PreviewFull
	}
	previewLines := parseApprovalPreviewLines(previewSource)
	previewWindow := previewWindow(previewLines, m.ApprovalPreviewOffset, approvalPreviewPageLines)
	addCount, delCount := approvalDiffStats(previewLines)
	bodyLines = append(bodyLines,
		sectionStyle.Render("preview"),
		renderApprovalPreviewSummary(m.ApprovalPreview, previewWindow, addCount, delCount, bodyWidth),
	)
	previewRendered := make([]string, 0, len(previewWindow.Lines))
	for _, line := range previewWindow.Lines {
		previewRendered = append(previewRendered, renderApprovalPreviewLines(line, maxInt(1, bodyWidth-6))...)
	}
	previewBlockWidth := maxInt(8, bodyWidth-2)
	previewBlock := renderBorderedTranscriptBlock("approval preview", previewRendered, previewBlockWidth, approvalRequiredStyle)
	bodyLines = append(bodyLines, renderScrollableBlock(previewBlock, bodyWidth, panelScrollState{
		Offset:  previewWindow.Start,
		Visible: minInt(previewWindow.Total, approvalPreviewPageLines),
		Total:   previewWindow.Total,
	})...)
	bodyLines = append(bodyLines, dimStyle.Render("j/k scroll  |  a approve  |  r reject"))
	return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
}

func planStepStatusLabel(status string) string {
	switch strings.TrimSpace(strings.ToLower(status)) {
	case "completed":
		return "done"
	case "in_progress":
		return "active"
	case "blocked":
		return "blocked"
	default:
		return "pending"
	}
}

func (m *Model) renderPlans(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	page := pageForSelection(len(m.ExecutionPlan.Steps), m.PlanIndex, m.planPanelPageSizeForDimensions(width, height))
	headerLines := []string{
		renderPanelHeaderColumns(bodyWidth, "sel ↑/↓", "page ←/→", "run ↵/r", "done d", "accept a", "clear c", "esc"),
	}
	footerLines := []string{renderPanelSummaryColumns(bodyWidth, "plans", fmt.Sprintf("page %d/%d", page.CurrentPage, page.TotalPages), fmt.Sprintf("steps %d", page.Total))}
	bodyLines := []string{}

	if len(m.ExecutionPlan.Steps) == 0 {
		bodyLines = append(bodyLines,
			renderPanelTitleLine(bodyWidth, PanelPlans, "plan", "no active execution plan"),
			dimStyle.Render("No active execution plan."),
			dimStyle.Render("Use /plan create <task> to build one, then /plan run to execute it."),
		)
		return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
	}

	bodyLines = append(bodyLines, renderPanelTitleLine(bodyWidth, PanelPlans, "plan", fmt.Sprintf("%d step(s)", len(m.ExecutionPlan.Steps))))
	if strings.TrimSpace(m.ExecutionPlan.Summary) != "" {
		for _, row := range wrapPlainText(m.ExecutionPlan.Summary, bodyWidth) {
			bodyLines = append(bodyLines, dimStyle.Render(row))
		}
	}
	if strings.TrimSpace(m.ExecutionPlan.ProjectRoot) != "" {
		for _, row := range wrapPlainText("project "+m.ExecutionPlan.ProjectRoot, bodyWidth) {
			bodyLines = append(bodyLines, dimStyle.Render(row))
		}
	}
	if strings.TrimSpace(m.ExecutionPlan.Objective) != "" {
		for _, row := range wrapPlainText("objective "+m.ExecutionPlan.Objective, bodyWidth) {
			bodyLines = append(bodyLines, dimStyle.Render(row))
		}
	}
	if strings.TrimSpace(m.ExecutionPlan.AcceptedAt) != "" {
		acceptedLabel := "accepted " + m.ExecutionPlan.AcceptedAt
		if strings.TrimSpace(m.ExecutionPlan.AcceptedSummary) != "" {
			acceptedLabel += "  |  " + m.ExecutionPlan.AcceptedSummary
		}
		for _, row := range wrapPlainText(acceptedLabel, bodyWidth) {
			bodyLines = append(bodyLines, dimStyle.Render(row))
		}
	}

	bodyLines = append(bodyLines, renderPanelSectionLabel("steps"))
	listLines := make([]string, 0, maxInt(1, (page.End-page.Start)*2))
	for index := page.Start; index < page.End; index++ {
		step := m.ExecutionPlan.Steps[index]
		prefix := "  "
		style := lipgloss.NewStyle()
		if index == m.PlanIndex {
			prefix = "> "
			style = asstStyle.Bold(true)
		}
		listLines = append(listLines, style.Render(fmt.Sprintf("%s%s  %s", prefix, planStepStatusLabel(step.Status), truncatePlain(step.Title, maxInt(12, bodyWidth-16)))))
		metaParts := []string{}
		if len(step.FilePaths) > 0 {
			metaParts = append(metaParts, fmt.Sprintf("%d path(s)", len(step.FilePaths)))
		}
		if len(step.Evidence) > 0 {
			metaParts = append(metaParts, fmt.Sprintf("%d evidence", len(step.Evidence)))
		}
		if strings.TrimSpace(step.RecentToolResult) != "" {
			metaParts = append(metaParts, truncatePlain(step.RecentToolResult, maxInt(8, bodyWidth-12)))
		}
		meta := strings.Join(metaParts, "  |  ")
		if meta == "" {
			meta = emptyFallback(strings.TrimSpace(step.Details), "no details")
		}
		listLines = append(listLines, dimStyle.Render("   "+truncatePlain(meta, maxInt(8, bodyWidth-6))))
	}
	bodyLines = append(bodyLines, renderScrollableBlock(listLines, bodyWidth, panelScrollState{
		Offset:  maxInt(0, page.CurrentPage-1),
		Visible: 1,
		Total:   maxInt(1, page.TotalPages),
	})...)

	selected := m.ExecutionPlan.Steps[clampInt(m.PlanIndex, 0, len(m.ExecutionPlan.Steps)-1)]
	bodyLines = append(bodyLines, "", renderPanelSectionLabel("detail"))
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("id %s  |  status %s", selected.ID, planStepStatusLabel(selected.Status))))
	if strings.TrimSpace(selected.Details) != "" {
		for _, row := range wrapPlainText(selected.Details, bodyWidth) {
			bodyLines = append(bodyLines, dimStyle.Render(row))
		}
	}
	if len(selected.FilePaths) > 0 {
		bodyLines = append(bodyLines, renderPanelSectionLabel("paths"))
		for _, path := range selected.FilePaths {
			for _, row := range wrapPlainText(path, bodyWidth) {
				bodyLines = append(bodyLines, dimStyle.Render(row))
			}
		}
	}
	if strings.TrimSpace(selected.RecentToolResult) != "" {
		bodyLines = append(bodyLines, renderPanelSectionLabel("latest tool"))
		for _, row := range wrapPlainText(selected.RecentToolResult, bodyWidth) {
			bodyLines = append(bodyLines, dimStyle.Render(row))
		}
	}
	if len(selected.Evidence) > 0 {
		bodyLines = append(bodyLines, renderPanelSectionLabel("evidence"))
		for _, item := range selected.Evidence {
			for _, row := range wrapPlainText(item, bodyWidth) {
				bodyLines = append(bodyLines, dimStyle.Render(row))
			}
		}
	}
	return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
}

func (m *Model) renderSessions(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	page := pageForSelection(len(m.Sessions), m.SessionIndex, m.sessionPanelPageSizeForDimensions(width, height))
	headerLines := []string{
		renderPanelHeaderColumns(bodyWidth, "sel ↑/↓", "page", "load ↵", "refresh", "esc"),
	}
	footerLines := []string{
		renderPanelSummaryColumns(bodyWidth, "sessions", fmt.Sprintf("page %d/%d", page.CurrentPage, page.TotalPages), fmt.Sprintf("total %d", page.Total)),
		"",
	}
	bodyLines := []string{}
	if len(m.Sessions) == 0 {
		bodyLines = append(bodyLines,
			renderPageHeroLine(bodyWidth, "sessions", "0 saved"),
		)
		bodyLines = append(bodyLines, renderPageHintLines(bodyWidth, "No saved sessions yet. Use /resume <id> to load one, or keep working to create a new session.")...)
		return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
	}
	selected := m.Sessions[clampInt(m.SessionIndex, 0, len(m.Sessions)-1)]
	heroSummary := fmt.Sprintf("%d saved  |  current %s", len(m.Sessions), emptyFallback(m.ActiveSessionID, "none"))
	bodyLines = append(bodyLines, renderPageHeroLine(bodyWidth, "sessions", heroSummary))
	bodyLines = append(bodyLines, renderPageHintLines(bodyWidth, "Enter load | arrows navigate | Esc back")...)
	bodyLines = append(bodyLines, sectionStyle.Render("list"))
	listLines := make([]string, 0, maxInt(1, (page.End-page.Start)*2))
	for index := page.Start; index < page.End; index++ {
		session := m.Sessions[index]
		prefix := "  "
		style := lipgloss.NewStyle()
		if index == m.SessionIndex {
			prefix = "> "
			style = asstStyle.Bold(true)
		}
		marker := ""
		if session.ID == m.ActiveSessionID {
			marker = " [current]"
		}
		listLines = append(listLines, style.Render(fmt.Sprintf("%s%s%s", prefix, truncatePlain(session.Title, bodyWidth-16), marker)))
		meta := session.UpdatedAt
		if project := strings.TrimSpace(session.ProjectRoot); project != "" {
			meta = fmt.Sprintf("%s  |  %s", session.UpdatedAt, formatProjectPathLabel(project, maxInt(12, bodyWidth-24)))
		}
		listLines = append(listLines, dimStyle.Render("   "+truncatePlain(meta, bodyWidth-6)))
	}
	bodyLines = append(bodyLines, renderScrollableBlock(listLines, bodyWidth, panelScrollState{
		Offset:  maxInt(0, page.CurrentPage-1),
		Visible: 1,
		Total:   maxInt(1, page.TotalPages),
	})...)
	bodyLines = append(bodyLines, "", sectionStyle.Render("detail"))
	bodyLines = append(bodyLines, pageSelectedBannerStyle.Render(truncatePlain(fmt.Sprintf("selected %s", selected.Title), bodyWidth)))
	bodyLines = append(bodyLines, renderApprovalMetaRow("id", selected.ID, bodyWidth))
	bodyLines = append(bodyLines, renderApprovalMetaRow("updated", selected.UpdatedAt, bodyWidth))
	if strings.TrimSpace(selected.ProjectRoot) != "" {
		bodyLines = append(bodyLines, renderApprovalMetaRow("project", selected.ProjectRoot, bodyWidth))
	} else {
		bodyLines = append(bodyLines, renderApprovalMetaRow("project", "none", bodyWidth))
	}
	if len(selected.Tags) > 0 {
		bodyLines = append(bodyLines, renderApprovalMetaRow("tags", strings.Join(selected.Tags, ", "), bodyWidth))
	} else {
		bodyLines = append(bodyLines, renderApprovalMetaRow("tags", "none", bodyWidth))
	}
	return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
}

func (m *Model) renderModels(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	listWidth := maxInt(1, bodyWidth-2)
	page := pageForSelection(len(m.AvailableModels), m.ModelIndex, m.modelPanelPageSizeForDimensions(width, height))
	headerLines := []string{
		renderPanelHeaderColumns(bodyWidth, "sel ↑/↓", "page ←/→", "switch ↵", "refresh r", "custom c", "esc"),
	}
	footerLines := []string{renderPanelSummaryColumns(bodyWidth, "models", fmt.Sprintf("page %d/%d", page.CurrentPage, page.TotalPages), fmt.Sprintf("total %d", page.Total))}
	bodyLines := []string{}
	bodyLines = append(bodyLines, renderPanelTitleLine(bodyWidth, PanelModels, "models", fmt.Sprintf("current %s", emptyFallback(m.CurrentModel, "none"))))
	bodyLines = append(bodyLines, renderPageHintLines(bodyWidth, modelCustomHint)...)
	if len(m.AvailableModels) == 0 {
		bodyLines = append(bodyLines, dimStyle.Render("No models available."))
		return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
	}
	bodyLines = append(bodyLines, renderPanelSectionLabel("list"))
	listLines := make([]string, 0, maxInt(1, (page.End-page.Start)*2))
	for index := page.Start; index < page.End; index++ {
		model := m.AvailableModels[index]
		prefix := "  "
		if index == m.ModelIndex {
			prefix = "> "
		}
		marker := ""
		if model == m.CurrentModel {
			marker = " [current]"
		}
		nameLine := fmt.Sprintf("%s%s%s", prefix, truncatePlain(model, bodyWidth-20), marker)
		familyLine := fmt.Sprintf("   family %s", modelFamily(model))
		if index == m.ModelIndex {
			listLines = append(listLines, renderFullWidthStyledLine(selectedPanelItemStyle, nameLine, listWidth))
			listLines = append(listLines, renderFullWidthStyledLine(selectedPanelItemStyle, familyLine, listWidth))
			continue
		}
		listLines = append(listLines, nameLine)
		listLines = append(listLines, dimStyle.Render(familyLine))
	}
	bodyLines = append(bodyLines, renderScrollableBlock(listLines, bodyWidth, panelScrollState{
		Offset:  maxInt(0, page.CurrentPage-1),
		Visible: 1,
		Total:   maxInt(1, page.TotalPages),
	})...)
	selected := m.AvailableModels[clampInt(m.ModelIndex, 0, len(m.AvailableModels)-1)]
	bodyLines = append(bodyLines, "", renderPanelSectionLabel("detail"))
	bodyLines = append(bodyLines, pageSelectedBannerStyle.Render(truncatePlain(fmt.Sprintf("selected %s", selected), bodyWidth)))
	bodyLines = append(bodyLines, renderApprovalMetaRow("family", modelFamily(selected), bodyWidth))
	bodyLines = append(bodyLines, renderApprovalMetaRow("provider", emptyFallback(m.CurrentProvider, "none"), bodyWidth))
	return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
}

func (m *Model) renderProviders(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	listWidth := maxInt(1, bodyWidth-2)
	page := pageForSelection(len(m.AvailableProviders), m.ProviderIndex, m.providerPanelPageSizeForDimensions(width, height))
	headerLines := []string{
		renderPanelHeaderColumns(bodyWidth, "sel ↑/↓", "page ←/→", "switch ↵", "refresh", "esc"),
	}
	footerLines := []string{renderPanelSummaryColumns(bodyWidth, "providers", fmt.Sprintf("page %d/%d", page.CurrentPage, page.TotalPages), fmt.Sprintf("total %d", page.Total))}
	bodyLines := []string{}
	if len(m.AvailableProviders) == 0 {
		bodyLines = append(bodyLines,
			renderPanelTitleLine(bodyWidth, PanelProviders, "providers", "0 configured"),
		)
		bodyLines = append(bodyLines, renderPageHintLines(bodyWidth, "No providers available. Use /login or /provider <url> to configure one.")...)
		return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
	}
	bodyLines = append(bodyLines, renderPanelTitleLine(bodyWidth, PanelProviders, "providers", fmt.Sprintf("current %s", m.providerDisplayName(m.CurrentProvider))))
	bodyLines = append(bodyLines, renderPageHintLines(bodyWidth, "Enter switch | refresh reloads providers and models | Esc back")...)
	bodyLines = append(bodyLines, renderPanelSectionLabel("list"))
	listLines := make([]string, 0, maxInt(1, (page.End-page.Start)*3))
	for index := page.Start; index < page.End; index++ {
		provider := m.AvailableProviders[index]
		prefix := "  "
		if index == m.ProviderIndex {
			prefix = "> "
		}
		marker := ""
		if provider == m.CurrentProvider {
			marker = " [current]"
		}
		name := m.providerDisplayName(provider)
		profile := formatProviderProfileLabel(m.providerProfile(provider))
		format := formatTransportFormatLabel(m.providerFormat(provider))
		source := formatProviderProfileSourceLabel(m.providerProfileSource(provider))
		nameLine := fmt.Sprintf("%s%s%s", prefix, truncatePlain(name, bodyWidth-20), marker)
		endpointLine := fmt.Sprintf("   endpoint %s  |  source %s", formatProviderLabel(provider, maxInt(8, bodyWidth)), source)
		profileLine := fmt.Sprintf("   profile %s  |  format %s", profile, format)
		if index == m.ProviderIndex {
			listLines = append(listLines, renderFullWidthStyledLine(selectedPanelItemStyle, nameLine, listWidth))
			listLines = append(listLines, renderFullWidthStyledLine(selectedPanelItemStyle, endpointLine, listWidth))
			listLines = append(listLines, renderFullWidthStyledLine(selectedPanelItemStyle, profileLine, listWidth))
			continue
		}
		listLines = append(listLines, nameLine)
		listLines = append(listLines, dimStyle.Render(endpointLine))
		listLines = append(listLines, dimStyle.Render(profileLine))
	}
	bodyLines = append(bodyLines, renderScrollableBlock(listLines, bodyWidth, panelScrollState{
		Offset:  maxInt(0, page.CurrentPage-1),
		Visible: 1,
		Total:   maxInt(1, page.TotalPages),
	})...)
	selected := m.AvailableProviders[clampInt(m.ProviderIndex, 0, len(m.AvailableProviders)-1)]
	bodyLines = append(bodyLines, "", renderPanelSectionLabel("detail"))
	bodyLines = append(bodyLines, pageSelectedBannerStyle.Render(truncatePlain(fmt.Sprintf("selected %s", m.providerDisplayName(selected)), bodyWidth)))
	bodyLines = append(bodyLines, renderApprovalMetaRow("url", selected, bodyWidth))
	bodyLines = append(bodyLines, renderApprovalMetaRow("profile", formatProviderProfileLabel(m.providerProfile(selected)), bodyWidth))
	bodyLines = append(bodyLines, renderApprovalMetaRow("source", formatProviderProfileSourceLabel(m.providerProfileSource(selected)), bodyWidth))
	bodyLines = append(bodyLines, renderApprovalMetaRow("format", formatTransportFormatLabel(m.providerFormat(selected)), bodyWidth))
	bodyLines = append(bodyLines, renderApprovalMetaRow("host", providerEndpointKind(selected, m.providerProfile(selected)), bodyWidth))
	for _, line := range m.providerEndpointDetailLines(selected, bodyWidth) {
		bodyLines = append(bodyLines, dimStyle.Render(line))
	}
	bodyLines = append(bodyLines, renderApprovalMetaRow("key", formatKeySourceLabel(m.CurrentProviderKeySource), bodyWidth))
	return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
}

func (m *Model) renderAuthPanel(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	stepLabel := strings.ToUpper(strings.ReplaceAll(string(m.AuthStep), "_", " "))
	headerLines := []string{
		renderPanelHeaderColumns(bodyWidth, "Alt+1-4", "tab/↑/↓", "enter", "esc"),
	}
	footerLines := []string{renderPanelSummaryColumns(bodyWidth, "auth", "step "+stepLabel)}
	bodyLines := []string{}
	bodyLines = append(bodyLines, renderPanelTitleLine(bodyWidth, PanelAuth, "login", "step "+stepLabel))
	bodyLines = append(bodyLines, renderPageHintLines(bodyWidth, fmt.Sprintf("mode %s  |  persistence %s", emptyFallback(m.Auth.Mode, "local"), emptyFallback(m.Auth.PersistenceLabel, "unavailable")))...)
	bodyLines = append(bodyLines, renderPanelErrorBanner(bodyWidth, m.AuthError)...)

	providerLine := formatAuthFieldLine(1, "Provider", string(m.AuthProvider), m.AuthStep == AuthStepProvider, bodyWidth)
	typeLine := formatAuthFieldLine(2, "Provider Type", string(m.AuthProviderType), m.AuthStep == AuthStepProviderType, bodyWidth)
	apiLine := formatAuthFieldLine(3, "API Key", maskSecret(string(m.AuthAPIKey)), m.AuthStep == AuthStepAPIKey, bodyWidth)
	modelLine := formatAuthFieldLine(4, "Model", emptyFallback(strings.TrimSpace(string(m.AuthModel)), m.CurrentModel), m.AuthStep == AuthStepModel, bodyWidth)
	confirmLine := "[5] Confirm and connect"
	if m.AuthStep == AuthStepConfirm {
		confirmLine = renderFullWidthStyledLine(selectedPanelItemStyle, confirmLine, bodyWidth)
	}
	bodyLines = append(bodyLines, renderPanelSectionLabel("fields"), providerLine, typeLine, apiLine, modelLine, confirmLine)
	if strings.TrimSpace(m.Auth.PersistencePath) != "" {
		bodyLines = append(bodyLines, renderApprovalMetaRow("path", m.Auth.PersistencePath, bodyWidth))
	}

	if m.AuthStep == AuthStepConfirm {
		bodyLines = append(bodyLines, "", renderPanelSectionLabel("detail"), pageSelectedBannerStyle.Render(truncatePlain("Press Enter to save login and rebuild the transport.", bodyWidth)))
	} else {
		bodyLines = append(bodyLines, "", renderPanelSectionLabel("editor"))
		for _, row := range m.authEditorLines(bodyWidth) {
			bodyLines = append(bodyLines, row)
		}
	}
	if m.AuthSaving {
		bodyLines = append(bodyLines, reviewStyle.Render("Saving login..."))
	}
	return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
}

func formatAuthFieldLine(index int, label, value string, selected bool, width int) string {
	line := fmt.Sprintf("[%d] %s  %s", index, label, emptyFallback(strings.TrimSpace(value), "(empty)"))
	if selected {
		return renderFullWidthStyledLine(selectedPanelItemStyle, line, width)
	}
	return line
}

func maskSecret(value string) string {
	if value == "" {
		return ""
	}
	return strings.Repeat("*", len([]rune(value)))
}

func (m *Model) authEditorLines(width int) []string {
	var current string
	switch m.AuthStep {
	case AuthStepProvider:
		current = string(m.AuthProvider)
	case AuthStepProviderType:
		current = string(m.AuthProviderType)
	case AuthStepAPIKey:
		current = maskSecret(string(m.AuthAPIKey))
	case AuthStepModel:
		current = string(m.AuthModel)
	default:
		current = ""
	}

	cursor := clampInt(m.AuthCursor, 0, len([]rune(current)))
	runes := []rune(current)
	plain := string(runes[:cursor]) + "|" + string(runes[cursor:])
	wrapped := wrapPlainText(plain, maxInt(8, width))
	if len(wrapped) == 0 {
		return []string{cursorStyle.Render("|")}
	}
	lines := make([]string, 0, len(wrapped))
	for _, row := range wrapped {
		lines = append(lines, strings.Replace(row, "|", cursorStyle.Render("|"), 1))
	}
	return lines
}

func (m *Model) providerProfile(provider string) string {
	if strings.TrimSpace(provider) == "" {
		return "none"
	}
	if value := strings.ToLower(strings.TrimSpace(m.ProviderProfiles[provider])); value != "" {
		return value
	}
	switch strings.TrimSpace(provider) {
	case "", "none":
		return "none"
	case "local-core":
		return "local"
	default:
		return "custom"
	}
}

func (m *Model) providerDisplayName(provider string) string {
	trimmed := strings.TrimSpace(provider)
	if trimmed == "" || trimmed == "none" {
		return "none"
	}
	if value := strings.TrimSpace(m.ProviderNames[trimmed]); value != "" {
		return value
	}
	return formatProviderName(trimmed, m.providerProfile(trimmed))
}

func (m *Model) currentProviderFormat() string {
	if format := strings.TrimSpace(m.CurrentProviderFormat); format != "" {
		return format
	}
	return m.providerFormat(m.CurrentProvider)
}

func (m *Model) providerFormat(provider string) string {
	trimmed := strings.TrimSpace(provider)
	if trimmed == "" || trimmed == "none" {
		return "none"
	}
	if trimmed == strings.TrimSpace(m.CurrentProvider) {
		if format := strings.TrimSpace(m.CurrentProviderFormat); format != "" {
			return format
		}
	}
	if value := strings.TrimSpace(m.ProviderFormats[trimmed]); value != "" {
		return value
	}
	if strings.ToLower(strings.TrimSpace(m.providerProfile(trimmed))) == "anthropic" {
		return "anthropic_messages"
	}
	return "openai_chat"
}

func (m *Model) providerEndpoint(provider, kind string) string {
	trimmed := strings.TrimSpace(provider)
	if trimmed == "" || trimmed == "none" {
		return ""
	}
	if value := strings.TrimSpace(m.ProviderEndpoints[trimmed][kind]); value != "" {
		return value
	}
	return ""
}

func (m *Model) providerEndpointDetailLines(provider string, bodyWidth int) []string {
	type endpointRow struct {
		label string
		kind  string
	}
	rows := []endpointRow{
		{label: "responses", kind: "responses"},
		{label: "chat", kind: "chat_completions"},
		{label: "models", kind: "models"},
		{label: "anthropic", kind: "anthropic_messages"},
		{label: "gemini", kind: "gemini_generate_content"},
	}
	lines := make([]string, 0, len(rows))
	for _, row := range rows {
		label := fmt.Sprintf("%-10s %s", row.label, formatProviderEndpointLabel(m.providerEndpoint(provider, row.kind)))
		lines = append(lines, label)
	}
	return lines
}

func (m *Model) providerProfileSource(provider string) string {
	profile := m.providerProfile(provider)
	if profile == "none" {
		return "none"
	}
	if profile == "local" {
		return "local"
	}
	if value := strings.ToLower(strings.TrimSpace(m.ProviderProfileSources[provider])); value != "" {
		return value
	}
	return "inferred"
}

type pageInfo struct {
	Start       int
	End         int
	CurrentPage int
	TotalPages  int
	Total       int
}

func pageForSelection(total, selected, pageSize int) pageInfo {
	if total <= 0 {
		return pageInfo{Start: 0, End: 0, CurrentPage: 1, TotalPages: 1, Total: 0}
	}
	safePageSize := maxInt(1, pageSize)
	current := clampInt(selected, 0, total-1)
	start := (current / safePageSize) * safePageSize
	end := minInt(total, start+safePageSize)
	totalPages := (total + safePageSize - 1) / safePageSize
	return pageInfo{
		Start:       start,
		End:         end,
		CurrentPage: (start / safePageSize) + 1,
		TotalPages:  totalPages,
		Total:       total,
	}
}

type approvalPreviewLine struct {
	Kind       string
	Text       string
	Key        string
	Val        string
	LineNumber string
	Content    string
	Section    string
}

type previewPage struct {
	Lines []approvalPreviewLine
	Start int
	End   int
	Total int
}

func parseApprovalPreviewLines(value string) []approvalPreviewLine {
	if strings.TrimSpace(value) == "" {
		return []approvalPreviewLine{{Kind: "context", Text: "(empty preview)"}}
	}

	rawLines := strings.Split(value, "\n")
	lines := make([]approvalPreviewLine, 0, len(rawLines))
	sectionMode := ""
	for index := 0; index < len(rawLines); index++ {
		row := rawLines[index]
		if isApprovalPreviewHeaderLine(row) {
			if index+1 < len(rawLines) && strings.TrimSpace(rawLines[index+1]) == "" {
				index++
			}
			continue
		}

		trimmed := strings.TrimSpace(row)
		switch {
		case strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]"):
			section := strings.TrimSpace(trimmed[1 : len(trimmed)-1])
			sectionMode = inferSectionDiffMode(section)
			lines = append(lines, approvalPreviewLine{Kind: "section", Text: row, Section: section})
		case strings.HasPrefix(row, "@@"):
			lines = append(lines, approvalPreviewLine{Kind: "hunk", Text: row})
		case diffPattern.MatchString(row):
			parts := diffPattern.FindStringSubmatch(row)
			kind := "add"
			if parts[1] == "-" {
				kind = "remove"
			}
			lines = append(lines, approvalPreviewLine{
				Kind:       kind,
				Text:       row,
				LineNumber: strings.TrimSpace(parts[2]),
				Content:    parts[3],
			})
		case strings.HasPrefix(row, "+"):
			lines = append(lines, approvalPreviewLine{Kind: "add", Text: row, Content: strings.TrimSpace(strings.TrimPrefix(row, "+"))})
		case strings.HasPrefix(row, "-"):
			lines = append(lines, approvalPreviewLine{Kind: "remove", Text: row, Content: strings.TrimSpace(strings.TrimPrefix(row, "-"))})
		case trimmed == "":
			lines = append(lines, approvalPreviewLine{Kind: "blank", Text: ""})
		default:
			if sectionMode != "" {
				if parts := numberedDiffPattern.FindStringSubmatch(row); len(parts) == 3 {
					lines = append(lines, approvalPreviewLine{
						Kind:       sectionMode,
						Text:       row,
						LineNumber: strings.TrimSpace(parts[1]),
						Content:    parts[2],
					})
					continue
				}
			}
			key, val, ok := splitPreviewKV(row)
			if ok {
				lines = append(lines, approvalPreviewLine{Kind: "kv", Text: row, Key: key, Val: val})
			} else {
				lines = append(lines, approvalPreviewLine{Kind: "context", Text: row})
			}
		}
	}
	return lines
}

func splitPreviewKV(row string) (string, string, bool) {
	match := kvPattern.FindStringSubmatch(strings.TrimSpace(row))
	if len(match) != 3 {
		return "", "", false
	}
	key := strings.TrimSpace(match[1])
	val := strings.TrimSpace(match[2])
	if key == "" {
		return "", "", false
	}
	return key, val, true
}

func inferSectionDiffMode(label string) string {
	normalized := strings.ToLower(strings.TrimSpace(label))
	switch {
	case normalized == "":
		return ""
	case strings.Contains(normalized, "old -"),
		strings.Contains(normalized, "to be removed"),
		strings.Contains(normalized, "to be overwritten"):
		return "remove"
	case strings.Contains(normalized, "new +"),
		strings.Contains(normalized, "to be written"):
		return "add"
	default:
		return ""
	}
}

func isApprovalPreviewHeaderLine(row string) bool {
	trimmed := strings.TrimSpace(row)
	if !strings.HasPrefix(trimmed, "action=") {
		return false
	}
	parts := strings.Split(trimmed, "|")
	if len(parts) == 0 {
		return false
	}
	for _, part := range parts {
		piece := strings.TrimSpace(part)
		if piece == "" || !headerKVPattern.MatchString(piece) {
			return false
		}
	}
	return true
}

func previewWindow(lines []approvalPreviewLine, offset, pageSize int) previewPage {
	if len(lines) == 0 {
		return previewPage{Lines: []approvalPreviewLine{}, Start: 0, End: 0, Total: 0}
	}
	safePage := maxInt(1, pageSize)
	safeOffset := clampInt(offset, 0, maxInt(0, len(lines)-safePage))
	end := minInt(len(lines), safeOffset+safePage)
	return previewPage{
		Lines: lines[safeOffset:end],
		Start: safeOffset,
		End:   end,
		Total: len(lines),
	}
}

func approvalDiffStats(lines []approvalPreviewLine) (int, int) {
	add := 0
	del := 0
	for _, line := range lines {
		if line.Kind == "add" {
			add++
		}
		if line.Kind == "remove" {
			del++
		}
	}
	return add, del
}

func renderApprovalMetaRow(key, value string, width int) string {
	keyText := approvalMetaKeyStyle.Render(strings.ToUpper(strings.TrimSpace(key)))
	plainPrefix := strings.ToUpper(strings.TrimSpace(key)) + "  "
	valueWidth := maxInt(1, width-lipgloss.Width(plainPrefix))
	valueText := strings.TrimSpace(value)
	valueStyle := approvalMetaValueStyle
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "path", "destination", "cwd":
		valueStyle = approvalPathStyle
	}
	renderedValue := truncatePlain(valueStyle.Render(valueText), valueWidth)
	return keyText + "  " + renderedValue
}

func renderApprovalPreviewSummary(mode ApprovalPreviewMode, page previewPage, addCount, delCount, width int) string {
	text := fmt.Sprintf("%s  %d-%d/%d  |  +%d -%d", mode, page.Start+1, page.End, page.Total, addCount, delCount)
	return dimStyle.Render(truncatePlain(text, width))
}

func renderApprovalPreviewLines(line approvalPreviewLine, width int) []string {
	maxWidth := maxInt(1, width)
	switch line.Kind {
	case "section":
		return []string{approvalSectionStyle.Render(truncatePlain("▌ "+emptyFallback(line.Section, "preview"), maxWidth))}
	case "hunk":
		return []string{diffHunkStyle.Render(truncatePlain(line.Text, maxWidth))}
	case "add":
		return renderTerminalDiffRows("+", line.LineNumber, emptyFallback(line.Content, line.Text), maxWidth, diffAddGutterStyle, diffAddLineStyle)
	case "remove":
		return renderTerminalDiffRows("-", line.LineNumber, emptyFallback(line.Content, line.Text), maxWidth, diffRemoveGutterStyle, diffRemoveLineStyle)
	case "kv":
		keyPlain := strings.TrimSpace(line.Key)
		keyPrefix := approvalMetaKeyStyle.Render(strings.ToUpper(keyPlain) + "  ")
		valueWidth := maxInt(1, maxWidth-lipgloss.Width(strings.ToUpper(keyPlain))-2)
		wrapped := wrapPlainText(line.Val, valueWidth)
		if len(wrapped) == 0 {
			return []string{truncatePlain(keyPrefix, maxWidth)}
		}
		lines := make([]string, 0, len(wrapped))
		valueStyle := approvalMetaValueStyle
		switch strings.ToLower(keyPlain) {
		case "path", "destination", "cwd":
			valueStyle = approvalPathStyle
		case "risk":
			valueStyle = approvalRiskStyle(line.Val)
		}
		for index, row := range wrapped {
			if index == 0 {
				lines = append(lines, truncatePlain(keyPrefix+valueStyle.Render(row), maxWidth))
				continue
			}
			lines = append(lines, truncatePlain(strings.Repeat(" ", lipgloss.Width(strings.ToUpper(keyPlain))+2)+valueStyle.Render(row), maxWidth))
		}
		return lines
	case "blank":
		return []string{""}
	default:
		wrapped := wrapPlainText(line.Text, maxWidth)
		if len(wrapped) == 0 {
			return []string{""}
		}
		return wrapped
	}
}

func renderTerminalDiffRows(sign, lineNumber, content string, width int, gutterStyle lipgloss.Style, lineStyle lipgloss.Style) []string {
	plainGutter := diffPlainGutter(sign, lineNumber)
	gutter := renderDiffGutter(sign, lineNumber, gutterStyle)
	contentWidth := maxInt(1, width-lipgloss.Width(plainGutter)-1)
	wrapped := wrapPlainText(content, contentWidth)
	if len(wrapped) == 0 {
		wrapped = []string{""}
	}
	lines := make([]string, 0, len(wrapped))
	continuation := renderDiffContinuationGutter(sign, plainGutter)
	for index, row := range wrapped {
		left := gutter
		if index > 0 {
			left = continuation
		}
		lines = append(lines, left+renderDiffCodeSegment(row, contentWidth, lineStyle))
	}
	return lines
}

func renderFullWidthStyledLine(style lipgloss.Style, text string, width int) string {
	if width <= 0 {
		return style.Render(text)
	}
	return style.
		Width(width).
		MaxWidth(width).
		Render(fitDisplayWidth(text, width))
}

func actionBadge(action string) string {
	normalized := strings.TrimSpace(action)
	switch normalized {
	case "run_command", "run_shell", "open_shell", "write_shell":
		return "[cmd] " + normalized
	case "delete_file":
		return "[del] " + normalized
	case "edit_file", "apply_patch":
		return "[edit] " + normalized
	case "create_file", "write_file", "create_dir", "copy_path", "move_path":
		return "[fs] " + normalized
	default:
		return normalized
	}
}

func describeApprovalAction(action string) string {
	switch action {
	case "create_file":
		return "new file"
	case "write_file":
		return "overwrite / write"
	case "edit_file":
		return "targeted edit"
	case "apply_patch":
		return "scoped patch"
	case "delete_file":
		return "delete"
	case "copy_path":
		return "copy path"
	case "move_path":
		return "move path"
	case "run_command":
		return "process"
	case "run_shell":
		return "shell command"
	case "open_shell":
		return "open shell session"
	case "write_shell":
		return "shell input"
	case "create_dir":
		return "new directory"
	default:
		return action
	}
}

func modelFamily(model string) string {
	normalized := strings.ToLower(strings.TrimSpace(model))
	switch {
	case strings.Contains(normalized, "gpt"), strings.Contains(normalized, "o1"), strings.Contains(normalized, "o3"), strings.Contains(normalized, "o4"):
		return "openai-like"
	case strings.Contains(normalized, "gemini"):
		return "gemini-like"
	case strings.Contains(normalized, "claude"):
		return "anthropic-like"
	case normalized == "":
		return "unknown"
	default:
		return "custom"
	}
}

func formatProviderLabel(provider string, max int) string {
	trimmed := strings.TrimSpace(provider)
	if trimmed == "" || trimmed == "none" {
		return "none"
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return truncatePlain(trimmed, max)
	}
	hostPath := parsed.Host
	if parsed.Path != "" && parsed.Path != "/" {
		hostPath += parsed.Path
	}
	return truncatePlain(hostPath, max)
}

func formatProviderName(provider, profile string) string {
	switch strings.ToLower(strings.TrimSpace(profile)) {
	case "openai":
		return "OpenAI"
	case "gemini":
		return "Gemini"
	case "anthropic":
		return "Anthropic"
	case "local":
		return "Local"
	}

	trimmed := strings.TrimSpace(provider)
	if trimmed == "" || trimmed == "none" {
		return "none"
	}

	parsed, err := url.Parse(trimmed)
	if err == nil && parsed.Hostname() != "" {
		host := strings.ToLower(strings.TrimSpace(parsed.Hostname()))
		if host == "localhost" || host == "127.0.0.1" {
			return "Local"
		}
		labels := strings.Split(host, ".")
		candidate := ""
		if len(labels) >= 2 {
			candidate = labels[len(labels)-2]
		} else if len(labels) == 1 {
			candidate = labels[0]
		}
		candidate = strings.Trim(candidate, "-_ ")
		if candidate != "" {
			return strings.ToUpper(candidate[:1]) + candidate[1:]
		}
	}

	return truncatePlain(trimmed, 24)
}

func formatProjectPathLabel(projectPath string, max int) string {
	trimmed := strings.TrimSpace(projectPath)
	if trimmed == "" || trimmed == "none" {
		return "none"
	}
	if max <= 0 || lipgloss.Width(trimmed) <= max {
		return trimmed
	}

	separator := "/"
	if strings.Contains(trimmed, `\`) {
		separator = `\`
	}

	root := ""
	switch {
	case strings.HasPrefix(trimmed, `\\`):
		root = `\\`
	case len(trimmed) >= 3 && trimmed[1] == ':' && (trimmed[2] == '\\' || trimmed[2] == '/'):
		root = trimmed[:3]
	case len(trimmed) >= 2 && trimmed[1] == ':':
		root = trimmed[:2]
	case strings.HasPrefix(trimmed, "/"):
		root = "/"
	}

	segments := strings.FieldsFunc(trimmed, func(r rune) bool {
		return r == '/' || r == '\\'
	})
	if len(segments) == 0 {
		return truncateMiddlePlain(trimmed, max)
	}

	minKeep := 2
	if len(segments) < minKeep {
		minKeep = len(segments)
	}
	for keep := minInt(4, len(segments)); keep >= minKeep; keep-- {
		tail := strings.Join(segments[len(segments)-keep:], separator)
		candidate := "..." + separator + tail
		if root != "" {
			candidate = root + "..." + separator + tail
		}
		if lipgloss.Width(candidate) <= max {
			return candidate
		}
	}

	last := segments[len(segments)-1]
	if root != "" {
		return truncateMiddlePlain(root+last, max)
	}
	return truncateMiddlePlain(last, max)
}

func formatProviderProfileLabel(profile string) string {
	switch strings.ToLower(strings.TrimSpace(profile)) {
	case "openai":
		return "OpenAI-compatible"
	case "gemini":
		return "Gemini-compatible"
	case "anthropic":
		return "Anthropic-compatible"
	case "local":
		return "Local"
	case "none":
		return "none"
	default:
		return "Custom"
	}
}

func formatProviderProfileSourceLabel(source string) string {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "manual":
		return "manual"
	case "local":
		return "local"
	case "none":
		return "none"
	default:
		return "inferred"
	}
}

func formatTransportFormatLabel(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "openai_chat":
		return "OpenAI Chat"
	case "openai_responses":
		return "OpenAI Responses"
	case "anthropic_messages":
		return "Anthropic Messages"
	case "gemini_generate_content":
		return "Gemini Native"
	case "", "none":
		return "none"
	default:
		return strings.TrimSpace(format)
	}
}

func formatProviderEndpointLabel(endpoint string) string {
	trimmed := strings.TrimSpace(endpoint)
	if trimmed == "" {
		return "auto"
	}
	return trimmed
}

func providerEndpointKind(provider, profile string) string {
	trimmedProvider := strings.TrimSpace(provider)
	if trimmedProvider == "" || trimmedProvider == "none" {
		return "none"
	}
	if strings.ToLower(strings.TrimSpace(profile)) == "local" {
		return "local"
	}
	parsed, err := url.Parse(trimmedProvider)
	if err != nil {
		return "custom"
	}
	host := strings.ToLower(parsed.Hostname())
	isOfficial := (profile == "openai" && strings.HasSuffix(host, "openai.com")) ||
		(profile == "gemini" && host == "generativelanguage.googleapis.com") ||
		(profile == "anthropic" && strings.HasSuffix(host, "anthropic.com"))
	if isOfficial {
		return "official"
	}
	return "relay/custom"
}

func formatKeySourceLabel(keySource string) string {
	normalized := strings.TrimSpace(keySource)
	switch normalized {
	case "", "unknown":
		return "unknown"
	case "CYRENE_OPENAI_API_KEY":
		return "openai env"
	case "CYRENE_GEMINI_API_KEY":
		return "gemini env"
	case "CYRENE_ANTHROPIC_API_KEY":
		return "anthropic env"
	case "CYRENE_API_KEY":
		return "shared env"
	case "process_env":
		return "process env"
	case "user_env":
		return "user env"
	default:
		return normalized
	}
}

func wrapLinesToWidth(lines []string, width int) []string {
	wrapped := make([]string, 0, len(lines))
	for _, line := range lines {
		if containsANSIEscape(line) {
			wrapped = append(wrapped, wrapANSIText(line, width)...)
			continue
		}
		wrapped = append(wrapped, wrapPlainText(line, width)...)
	}
	return wrapped
}

func limitBoxLines(lines []string, width, height int) string {
	if height <= 0 {
		return ""
	}
	limited := make([]string, 0, height)
	for _, line := range lines {
		var wrappedRows []string
		if containsANSIEscape(line) {
			wrappedRows = wrapANSIText(line, maxInt(1, width))
		} else {
			wrappedRows = wrapPlainText(line, maxInt(1, width))
		}
		for _, wrapped := range wrappedRows {
			limited = append(limited, fitDisplayWidth(wrapped, width))
			if len(limited) == height {
				return strings.Join(limited, "\n")
			}
		}
	}
	for len(limited) < height {
		limited = append(limited, "")
	}
	return strings.Join(limited, "\n")
}

func expandBoxLines(lines []string, width int) []string {
	if width <= 0 || len(lines) == 0 {
		return nil
	}
	expanded := make([]string, 0, len(lines))
	for _, line := range lines {
		var wrappedRows []string
		if containsANSIEscape(line) {
			wrappedRows = wrapANSIText(line, maxInt(1, width))
		} else {
			wrappedRows = wrapPlainText(line, maxInt(1, width))
		}
		for _, row := range wrappedRows {
			expanded = append(expanded, fitDisplayWidth(row, width))
		}
	}
	return expanded
}

func renderPanelBox(width, height, bodyWidth, bodyHeight int, headerLines, bodyLines, footerLines []string) string {
	header := expandBoxLines(headerLines, bodyWidth)
	footer := expandBoxLines(footerLines, bodyWidth)
	body := expandBoxLines(bodyLines, bodyWidth)

	if len(footer) > bodyHeight {
		footer = footer[len(footer)-bodyHeight:]
		header = nil
		body = nil
	} else if len(header)+len(footer) > bodyHeight {
		availableHeader := maxInt(0, bodyHeight-len(footer))
		if len(header) > availableHeader {
			header = header[:availableHeader]
		}
		body = nil
	}

	availableBody := maxInt(0, bodyHeight-len(header)-len(footer))
	if len(body) > availableBody {
		body = body[:availableBody]
	}

	rendered := make([]string, 0, bodyHeight)
	rendered = append(rendered, header...)
	rendered = append(rendered, body...)
	for len(rendered) < bodyHeight-len(footer) {
		rendered = append(rendered, strings.Repeat(" ", maxInt(1, bodyWidth)))
	}
	rendered = append(rendered, footer...)
	for len(rendered) < bodyHeight {
		rendered = append(rendered, strings.Repeat(" ", maxInt(1, bodyWidth)))
	}

	return panelBoxStyle.
		Width(framedRenderWidth(panelBoxStyle, width)).
		Height(framedRenderHeight(panelBoxStyle, height)).
		Render(strings.Join(rendered, "\n"))
}

type panelScrollState struct {
	Offset  int
	Visible int
	Total   int
}

func renderScrollableBlock(lines []string, width int, scroll panelScrollState) []string {
	if len(lines) == 0 {
		return nil
	}
	scrollbarWidth := 2
	contentWidth := maxInt(1, width-scrollbarWidth)
	trackHeight := maxInt(0, len(lines)-2)
	thumbStart, thumbSize := scrollbarThumb(scroll, trackHeight)
	rendered := make([]string, 0, len(lines))
	for index, line := range lines {
		base := fitDisplayWidth(line, contentWidth)
		glyph := " "
		if index >= 0 && index < len(lines)-1 {
			trackIndex := index
			glyph = scrollbarTrackStyle().Render("│")
			if trackIndex >= thumbStart && trackIndex < thumbStart+thumbSize {
				glyph = scrollbarThumbStyle().Render("█")
			}
		}
		rendered = append(rendered, fitDisplayWidth(base+" "+glyph, width))
	}
	return rendered
}

func scrollbarThumb(scroll panelScrollState, height int) (int, int) {
	if height <= 0 || scroll.Total <= 0 || scroll.Visible <= 0 {
		return 0, 0
	}
	visible := minInt(scroll.Visible, scroll.Total)
	if scroll.Total <= visible {
		return 0, 1
	}
	if visible == 1 {
		maxOffset := maxInt(1, scroll.Total-visible)
		offset := clampInt(scroll.Offset, 0, maxOffset)
		maxStart := maxInt(0, height-1)
		thumbStart := int(float64(offset) / float64(maxOffset) * float64(maxStart))
		return clampInt(thumbStart, 0, maxStart), 1
	}
	thumbSize := maxInt(1, int(float64(height)*float64(visible)/float64(scroll.Total)))
	if thumbSize > height {
		thumbSize = height
	}
	maxOffset := maxInt(1, scroll.Total-visible)
	offset := clampInt(scroll.Offset, 0, maxOffset)
	maxStart := maxInt(0, height-thumbSize)
	thumbStart := int(float64(offset) / float64(maxOffset) * float64(maxStart))
	return clampInt(thumbStart, 0, maxStart), thumbSize
}

func scrollbarSeparatorStyle() lipgloss.Style {
	return dimStyle.Copy().Foreground(lipgloss.Color("8"))
}

func scrollbarTrackStyle() lipgloss.Style {
	return dimStyle.Copy().Foreground(uiBorderMutedColor)
}

func scrollbarThumbStyle() lipgloss.Style {
	return asstStyle.Copy().Foreground(uiAccentYellowColor).Bold(true)
}

func containsANSIEscape(value string) bool {
	return strings.Contains(value, "\x1b[")
}

func framedInnerWidth(style lipgloss.Style, outerWidth int) int {
	return maxInt(1, outerWidth-style.GetHorizontalFrameSize())
}

func framedInnerHeight(style lipgloss.Style, outerHeight int) int {
	return maxInt(1, outerHeight-style.GetVerticalFrameSize())
}

func framedRenderWidth(style lipgloss.Style, outerWidth int) int {
	return maxInt(1, outerWidth-style.GetHorizontalBorderSize())
}

func framedRenderHeight(style lipgloss.Style, outerHeight int) int {
	return maxInt(1, outerHeight-style.GetVerticalBorderSize())
}

func messageStyles(message Message) (string, lipgloss.Style, lipgloss.Style) {
	switch message.Kind {
	case "tool_status":
		return "tool>", reviewStyle.Bold(true), reviewStyle
	case "review_status":
		return "review>", reviewStyle.Bold(true), reviewStyle
	case "system_hint":
		return "system>", systemStyle.Bold(true), systemStyle
	case "error":
		return "error>", errorStyle.Bold(true), errorStyle
	}

	switch message.Role {
	case "user":
		return "user>", userStyle.Bold(true), lipgloss.NewStyle()
	case "assistant":
		return "assistant>", asstStyle.Bold(true), lipgloss.NewStyle()
	default:
		return "system>", systemStyle.Bold(true), systemStyle
	}
}

func transcriptBodyStyle(message Message) lipgloss.Style {
	switch {
	case message.Role == "user":
		return lipgloss.NewStyle()
	case message.Role == "assistant":
		return lipgloss.NewStyle()
	case message.Kind == "tool_status":
		return toolStatusStyle
	case message.Kind == "review_status":
		return reviewStyle.Copy().Bold(false)
	case message.Kind == "error":
		return errorStyle.Copy().Bold(false)
	default:
		return systemStyle
	}
}

func shouldRenderCompactTranscript(message Message) bool {
	switch message.Kind {
	case "transcript", "tool_status", "review_status", "system_hint", "error":
		return true
	default:
		return false
	}
}

func promptStyleForStatus(status Status) lipgloss.Style {
	switch status {
	case StatusPreparing, StatusRequesting, StatusStreaming, StatusAwaitingReview:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("11"))
	case StatusError:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("9"))
	default:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("14"))
	}
}

func statusBadgeStyle(status Status) lipgloss.Style {
	switch status {
	case StatusPreparing:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("11"))
	case StatusRequesting, StatusStreaming:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("12"))
	case StatusAwaitingReview:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("11"))
	case StatusError:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("9"))
	default:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("10"))
	}
}

func statusLabel(status Status) Status {
	switch status {
	case StatusPreparing:
		return "preparing"
	case StatusRequesting:
		return "requesting"
	case StatusStreaming:
		return "working"
	case StatusAwaitingReview:
		return "review"
	case StatusError:
		return "error"
	default:
		return "ready"
	}
}

func truncatePlain(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if displayWidth(value) <= width {
		return value
	}
	if width == 1 {
		return "~"
	}
	return truncateDisplayWidth(value, width, "~")
}

func fitDisplayWidth(value string, width int) string {
	if width <= 0 {
		return ""
	}
	truncated := truncateDisplayWidth(value, width, "")
	padding := maxInt(0, width-displayWidth(truncated))
	if padding == 0 {
		return truncated
	}
	return truncated + strings.Repeat(" ", padding)
}

func truncateMultilineDisplayWidth(value string, width int) string {
	if width <= 0 || value == "" {
		return ""
	}
	lines := strings.Split(value, "\n")
	for index, line := range lines {
		if displayWidth(line) > width {
			lines[index] = truncateDisplayWidth(line, width, "")
		}
	}
	return strings.Join(lines, "\n")
}

func truncateMiddlePlain(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if displayWidth(value) <= width {
		return value
	}
	if width <= 3 {
		return strings.Repeat(".", width)
	}

	leftBudget := (width - 3) / 2
	rightBudget := width - 3 - leftBudget

	left := cutDisplayWidth(value, 0, leftBudget)
	right := cutDisplayWidth(value, maxInt(0, displayWidth(value)-rightBudget), displayWidth(value))
	return left + "..." + right
}

func wrapPlainText(value string, width int) []string {
	if width <= 0 {
		return []string{""}
	}

	segments := strings.Split(value, "\n")
	lines := make([]string, 0, len(segments))
	for _, segment := range segments {
		if segment == "" {
			lines = append(lines, "")
			continue
		}

		var current strings.Builder
		currentWidth := 0
		graphemes := uniseg.NewGraphemes(segment)
		for graphemes.Next() {
			cluster := graphemes.Str()
			clusterWidth := safeClusterDisplayWidth(cluster, graphemes.Width())
			if currentWidth+clusterWidth > width && currentWidth > 0 {
				lines = append(lines, current.String())
				current.Reset()
				currentWidth = 0
			}
			current.WriteString(cluster)
			currentWidth += clusterWidth
		}
		if current.Len() > 0 {
			lines = append(lines, current.String())
		}
	}

	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}

func wrapANSIText(value string, width int) []string {
	if width <= 0 {
		return []string{""}
	}
	if value == "" {
		return []string{""}
	}
	wrapped := ansi.Wrap(value, width, "")
	lines := strings.Split(wrapped, "\n")
	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}

func runeDisplayWidth(r rune) int {
	switch {
	case r == '\t':
		return 4
	case r < 32 || (r >= 0x7f && r < 0xa0):
		return 0
	case r <= unicode.MaxASCII:
		return 1
	default:
		return lipgloss.Width(string(r))
	}
}

func displayWidth(value string) int {
	return maxInt(ansi.StringWidth(value), ansi.StringWidthWc(value))
}

func truncateDisplayWidth(value string, width int, tail string) string {
	if width <= 0 {
		return ""
	}
	if displayWidth(value) <= width {
		return value
	}
	tailWidth := displayWidth(tail)
	contentWidth := width - tailWidth
	if contentWidth < 0 {
		return ""
	}
	return cutRightDisplayWidth(value, contentWidth) + tail
}

func cutDisplayWidth(value string, left, right int) string {
	if right <= left {
		return ""
	}
	if left <= 0 {
		return cutRightDisplayWidth(value, right)
	}
	return cutRightDisplayWidth(cutLeftDisplayWidth(value, left), right-left)
}

func cutLeftDisplayWidth(value string, width int) string {
	if width <= 0 {
		return value
	}
	if displayWidth(value) <= width {
		return ""
	}

	var builder strings.Builder
	skipping := true
	currentWidth := 0
	for index := 0; index < len(value); {
		if sequence, size, ok := readANSIEscape(value[index:]); ok {
			if !skipping {
				builder.WriteString(sequence)
			}
			index += size
			continue
		}

		cluster, clusterWidth := nextDisplayCluster(value[index:])
		if cluster == "" {
			break
		}
		index += len(cluster)
		if skipping {
			currentWidth += clusterWidth
			if currentWidth <= width {
				continue
			}
			skipping = false
		}
		builder.WriteString(cluster)
	}
	return builder.String()
}

func cutRightDisplayWidth(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if displayWidth(value) <= width {
		return value
	}

	var builder strings.Builder
	currentWidth := 0
	truncated := false
	for index := 0; index < len(value); {
		if sequence, size, ok := readANSIEscape(value[index:]); ok {
			builder.WriteString(sequence)
			index += size
			continue
		}

		cluster, clusterWidth := nextDisplayCluster(value[index:])
		if cluster == "" {
			break
		}
		if currentWidth+clusterWidth > width {
			truncated = true
			break
		}
		builder.WriteString(cluster)
		currentWidth += clusterWidth
		index += len(cluster)
	}
	if truncated && containsANSIEscape(value) {
		builder.WriteString("\x1b[0m")
	}
	return builder.String()
}

func nextDisplayCluster(value string) (string, int) {
	if value == "" {
		return "", 0
	}
	graphemes := uniseg.NewGraphemes(value)
	if !graphemes.Next() {
		return "", 0
	}
	cluster := graphemes.Str()
	return cluster, safeClusterDisplayWidth(cluster, graphemes.Width())
}

func safeClusterDisplayWidth(cluster string, fallback int) int {
	return maxInt(fallback, maxInt(ansi.StringWidth(cluster), ansi.StringWidthWc(cluster)))
}

func readANSIEscape(value string) (string, int, bool) {
	if len(value) < 2 || value[0] != '\x1b' {
		return "", 0, false
	}
	switch value[1] {
	case '[':
		for index := 2; index < len(value); index++ {
			if value[index] >= 0x40 && value[index] <= 0x7E {
				return value[:index+1], index + 1, true
			}
		}
	case ']':
		for index := 2; index < len(value); index++ {
			if value[index] == '\a' {
				return value[:index+1], index + 1, true
			}
			if value[index] == '\x1b' && index+1 < len(value) && value[index+1] == '\\' {
				return value[:index+2], index + 2, true
			}
		}
	}
	return "", 0, false
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func clampInt(value, lower, upper int) int {
	if value < lower {
		return lower
	}
	if value > upper {
		return upper
	}
	return value
}

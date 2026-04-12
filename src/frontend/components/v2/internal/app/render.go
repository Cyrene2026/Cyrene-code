package app

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

var (
	rootStyle = lipgloss.NewStyle()

	statusBarColor = lipgloss.Color("#FFF")

	startupLogoTrueColorStart = rgbColor{R: 0x2F, G: 0x81, B: 0xFF}
	startupLogoTrueColorEnd   = rgbColor{R: 0xA8, G: 0x55, B: 0xF7}
	startupLogoANSI256Palette = []string{"27", "33", "39", "63", "69", "99", "129", "135"}
	startupLogoANSIPalette    = []string{"12", "12", "13", "13"}

	appShellStyle = lipgloss.NewStyle().
			Border(lipgloss.DoubleBorder()).
			BorderForeground(lipgloss.Color("13")).
			Padding(0)

	frameStyle = lipgloss.NewStyle().
			Border(lipgloss.NormalBorder()).
			BorderForeground(lipgloss.Color("12")).
			Padding(0, 1)

	activeFrameStyle = frameStyle.Copy().
				BorderForeground(lipgloss.Color("11"))

	brandChipStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("11")).
			Padding(0, 1)

	titleStyle     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("13"))
	dimStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("7"))
	errorStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("9")).Bold(true)
	userStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("10")).Bold(true)
	asstStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("14")).Bold(true)
	reviewStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("11")).Bold(true)
	systemStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("12"))
	sectionStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("13"))
	codeBlockStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("7")).
			Padding(0, 0)
	inlineCodeStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("14")).
			Underline(true)
	codeFenceStyle   = dimStyle.Copy().Italic(true)
	codeKeywordStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("13")).Bold(true)
	codeStringStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	codeCommentStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("8")).Italic(true)
	codeNumberStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	codePlainStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("7"))

	inputBoxStyle = lipgloss.NewStyle().
			Border(lipgloss.NormalBorder()).
			BorderForeground(lipgloss.Color("12")).
			Padding(0, 1)

	focusedInputBoxStyle = inputBoxStyle.Copy().
				BorderForeground(lipgloss.Color("11"))

	panelBoxStyle = lipgloss.NewStyle().
			Border(lipgloss.NormalBorder()).
			BorderForeground(lipgloss.Color("12")).
			Padding(0, 1)

	panelHeaderBarStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color("0")).
				Background(lipgloss.Color("#FFF"))

	panelSummaryStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color("15"))

	cursorStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("14"))
	statusKeyStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("14"))
	statusChipBase = lipgloss.NewStyle().
			Border(lipgloss.NormalBorder()).
			Padding(0, 1)
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
	diffPattern         = regexp.MustCompile(`^([+-])\s*(\d+)?\s*\|\s?(.*)$`)
	numberedDiffPattern = regexp.MustCompile(`^\s*(\d+)\s*\|\s?(.*)$`)
	orderedListPattern  = regexp.MustCompile(`^(\d+)[.)]\s+(.*)$`)
	kvPattern           = regexp.MustCompile(`^([a-z][a-z0-9_ ]*):\s*(.*)$`)
	headerKVPattern     = regexp.MustCompile(`^[a-z_]+=.*$`)
)

func (m *Model) View() string {
	width := maxInt(50, m.Width)
	height := maxInt(18, m.Height)
	contentWidth := maxInt(30, framedInnerWidth(appShellStyle, width))
	contentHeight := maxInt(12, framedInnerHeight(appShellStyle, height))

	header := m.renderTopStatusBar(contentWidth)
	composer := m.renderComposer(contentWidth)
	footer := m.renderBottomStatusBar(contentWidth)
	fixedHeight := lipgloss.Height(header) + lipgloss.Height(composer) + lipgloss.Height(footer) + 2
	bodyHeight := maxInt(5, contentHeight-fixedHeight)
	body := m.renderMainArea(contentWidth, bodyHeight)

	parts := []string{
		header,
		body,
		composer,
		footer,
	}
	content := strings.Join(parts, "\n")
	return rootStyle.Width(width).Height(height).Render(
		appShellStyle.Width(contentWidth).Render(content),
	)
}

func (m *Model) renderMainArea(width, height int) string {
	contentHeight := maxInt(1, height)

	if m.ActivePanel == PanelNone {
		return m.renderSessionPane(width, contentHeight, true)
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
	}

	maxPanelWidth := totalWidth - minSessionWidth - 1
	if maxPanelWidth < minPanelWidth {
		return clampInt(totalWidth/3, 34, maxInt(34, totalWidth-25))
	}

	upperBound := 68
	if m.ActivePanel == PanelApprovals {
		upperBound = 76
	}
	return clampInt(desiredWidth, minPanelWidth, minInt(upperBound, maxPanelWidth))
}

func (m *Model) renderTopStatusBar(width int) string {
	return renderStatusColumns(width,
		statusColumn{Label: "STATUS", Value: m.renderAnimatedStatusLabel(), Color: statusBarColor},
		statusColumn{Label: "PANEL", Value: emptyFallback(string(m.ActivePanel), "none"), Color: statusBarColor},
		statusColumn{Label: "PENDING", Value: fmt.Sprintf("%d", len(m.PendingReviews)), Color: statusBarColor},
		statusColumn{Label: "PROJECT", Value: formatProjectPathLabel(m.AppRoot, statusValueWidth(width, 4, "PROJECT")), Color: statusBarColor},
	)
}

func (m *Model) renderBottomStatusBar(width int) string {
	return renderStatusColumns(width,
		statusColumn{Label: "SESSION", Value: emptyFallback(m.ActiveSessionID, "none"), Color: statusBarColor},
		statusColumn{Label: "MODEL", Value: emptyFallback(m.CurrentModel, "none"), Color: statusBarColor},
		statusColumn{Label: "FORMAT", Value: formatTransportFormatLabel(m.currentProviderFormat()), Color: statusBarColor},
		statusColumn{Label: "PROVIDER", Value: m.providerDisplayName(m.CurrentProvider), Color: statusBarColor},
		statusColumn{Label: "KEY", Value: formatKeySourceLabel(m.CurrentProviderKeySource), Color: statusBarColor},
	)
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

func (m *Model) renderTranscriptWindow(width, height int) ([]string, panelScrollState) {
	allLines := m.renderTranscriptLines(width)
	total := len(allLines)
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
	style := frameStyle.Copy().BorderForeground(lipgloss.Color("11"))
	if active {
		style = activeFrameStyle.Copy().BorderForeground(lipgloss.Color("11"))
	}
	bodyWidth := framedInnerWidth(style, width)
	bodyHeight := framedInnerHeight(style, height)
	contentWidth := maxInt(1, bodyWidth-2)
	lines, scroll := m.renderTranscriptWindow(contentWidth, maxInt(1, bodyHeight))
	rendered := renderScrollableBlock(lines, bodyWidth, scroll)
	return style.Width(framedRenderWidth(style, width)).Height(framedRenderHeight(style, height)).Render(strings.Join(rendered, "\n"))
}

func (m *Model) renderTranscriptLines(width int) []string {
	if m.transcriptCacheWidth == width && m.transcriptCacheVersion == m.transcriptVersion && m.transcriptCacheLines != nil {
		return m.transcriptCacheLines
	}

	if m.shouldShowStartupView() {
		lines := m.renderStartupLines(width)
		if m.ActivePanel != PanelNone {
			lines = m.renderCompactStartupLines(width)
		}
		m.transcriptCacheWidth = width
		m.transcriptCacheVersion = m.transcriptVersion
		m.transcriptCacheLines = lines
		return lines
	}

	items := make([]Message, 0, len(m.Items)+1)
	items = append(items, m.Items...)
	if strings.TrimSpace(m.LiveText) != "" {
		items = append(items, Message{Role: "assistant", Kind: "transcript", Text: m.LiveText})
	}

	lines := make([]string, 0, len(items)*3)
	for index, item := range items {
		lines = append(lines, renderMessageLines(item, width)...)
		if index < len(items)-1 && item.Kind == "transcript" && items[index+1].Kind != "transcript" {
			lines = append(lines, "")
		}
	}
	if len(lines) == 0 {
		lines = append(lines, dimStyle.Render("No transcript yet."))
	}

	m.transcriptCacheWidth = width
	m.transcriptCacheVersion = m.transcriptVersion
	m.transcriptCacheLines = lines
	return lines
}

func (m *Model) shouldShowStartupView() bool {
	if strings.TrimSpace(m.LiveText) != "" {
		return false
	}
	if len(m.Items) == 0 {
		return true
	}
	if len(m.Items) == 1 && m.Items[0].Role == "system" {
		return true
	}
	return false
}

func (m *Model) renderStartupLines(width int) []string {
	lines := make([]string, 0, len(startupShadowLogoLines)+18)
	logoLines, logoWidth := startupLogoLinesForWidth(width)
	for index, line := range logoLines {
		lines = append(lines, renderGradientLogoLine(line, index, len(logoLines), logoWidth))
	}

	lines = append(lines,
		"",
		titleStyle.Bold(true).Render("terminal workspace"),
		dimStyle.Render("Bubble Tea terminal workspace for the current project."),
		dimStyle.Render(truncatePlain(fmt.Sprintf("mode %s  |  model %s  |  provider %s", emptyFallback(m.Auth.Mode, "local"), emptyFallback(m.CurrentModel, "none"), emptyFallback(m.CurrentProvider, "none")), width)),
		dimStyle.Render(truncatePlain(fmt.Sprintf("session %s  |  pending %d", emptyFallback(m.ActiveSessionID, "none"), len(m.PendingReviews)), width)),
		"",
		reviewStyle.Bold(true).Render("fast paths"),
		"• Explain this repo  - summarize structure, stack, or one file.",
		"• Fix a bug  - describe the failure and let Cyrene patch it.",
		"• Connect HTTP  - use /login to save credentials.",
		"• Continue work  - use /sessions, /review, /model, or /provider.",
		"",
		sectionStyle.Render("terminal advantages"),
		"• Keyboard-first panels for sessions, approvals, providers, and models.",
		"• Dense transcript + inspector layout when a panel is open.",
		"• One-screen workflow without leaving the terminal.",
		"",
		"Use /help for full command reference.",
	)
	return wrapLinesToWidth(lines, width)
}

func (m *Model) renderCompactStartupLines(width int) []string {
	lines := []string{
		titleStyle.Bold(true).Render("terminal workspace"),
		dimStyle.Render("Startup splash is compressed while the inspector is open."),
		dimStyle.Render(truncatePlain(fmt.Sprintf("active panel  %s", emptyFallback(string(m.ActivePanel), "none")), width)),
		dimStyle.Render(truncatePlain(fmt.Sprintf("project       %s", formatProjectPathLabel(m.AppRoot, maxInt(12, width-14))), width)),
		dimStyle.Render(truncatePlain(fmt.Sprintf("session       %s", emptyFallback(m.ActiveSessionID, "none")), width)),
		dimStyle.Render(truncatePlain(fmt.Sprintf("model         %s", emptyFallback(m.CurrentModel, "none")), width)),
		dimStyle.Render(truncatePlain(fmt.Sprintf("format        %s", formatTransportFormatLabel(m.currentProviderFormat())), width)),
		dimStyle.Render(truncatePlain(fmt.Sprintf("provider      %s", m.providerDisplayName(m.CurrentProvider)), width)),
		dimStyle.Render(truncatePlain(fmt.Sprintf("key source    %s", formatKeySourceLabel(m.CurrentProviderKeySource)), width)),
		dimStyle.Render(truncatePlain(fmt.Sprintf("pending       %d", len(m.PendingReviews)), width)),
		"",
		sectionStyle.Render("next"),
		"/help  command reference and shortcuts",
		"/sessions  /review  /model  /provider",
		"Esc closes the panel and restores the full startup view.",
	}
	return wrapLinesToWidth(lines, width)
}

func renderMessageLines(message Message, width int) []string {
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

func sanitizeTranscriptDisplayText(message Message) string {
	if message.Role != "assistant" || message.Kind != "transcript" {
		return message.Text
	}

	rawLines := strings.Split(message.Text, "\n")
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
		strings.HasPrefix(trimmed, "</minimax:tool_call"):
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
	inCodeBlock := false

	for index := 0; index < len(rawLines); index++ {
		raw := rawLines[index]
		trimmed := strings.TrimSpace(raw)
		if strings.HasPrefix(trimmed, "```") {
			inCodeBlock = !inCodeBlock
			lang := strings.TrimSpace(strings.TrimPrefix(trimmed, "```"))
			if lang != "" {
				lines = append(lines, codeFenceStyle.Render("code "+lang))
			}
			continue
		}

		if inCodeBlock {
			wrapped := wrapPlainText(raw, maxInt(1, width-2))
			if len(wrapped) == 0 {
				lines = append(lines, "│ "+codeBlockStyle.Render(""))
				continue
			}
			for _, row := range wrapped {
				lines = append(lines, "│ "+codeBlockStyle.Render(renderCodeLine(row)))
			}
			continue
		}

		if table, consumed, ok := parseMarkdownTable(rawLines[index:]); ok {
			lines = append(lines, renderMarkdownTable(table, width, baseStyle)...)
			index += consumed - 1
			continue
		}

		switch {
		case diffPattern.MatchString(raw):
			parts := diffPattern.FindStringSubmatch(raw)
			sign := "+"
			if len(parts) > 1 && strings.TrimSpace(parts[1]) == "-" {
				sign = "-"
			}
			lineNumber := ""
			if len(parts) > 2 {
				lineNumber = strings.TrimSpace(parts[2])
			}
			content := ""
			if len(parts) > 3 {
				content = parts[3]
			}
			lines = append(lines, renderDiffRows(sign, lineNumber, content, width)...)
		case strings.HasPrefix(trimmed, "@@"):
			for _, row := range wrapPlainText(raw, width) {
				lines = append(lines, asstStyle.Bold(true).Render(row))
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
			heading := strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
			for _, row := range wrapPlainText(heading, width) {
				lines = append(lines, titleStyle.Bold(true).Render(row))
			}
		case orderedListPattern.MatchString(trimmed):
			matches := orderedListPattern.FindStringSubmatch(trimmed)
			prefix := ""
			content := trimmed
			if len(matches) >= 3 {
				prefix = strings.TrimSpace(matches[1]) + ". "
				content = matches[2]
			}
			for index, row := range wrapPlainText(content, maxInt(1, width-lipgloss.Width(prefix))) {
				if index == 0 {
					lines = append(lines, dimStyle.Render(prefix)+renderInlineMarkdown(row, baseStyle))
					continue
				}
				lines = append(lines, strings.Repeat(" ", lipgloss.Width(prefix))+renderInlineMarkdown(row, baseStyle))
			}
		case strings.HasPrefix(trimmed, "- "),
			strings.HasPrefix(trimmed, "* "),
			strings.HasPrefix(trimmed, "> "):
			prefix := ""
			content := raw
			style := baseStyle
			switch {
			case strings.HasPrefix(trimmed, "- "), strings.HasPrefix(trimmed, "* "):
				prefix = "• "
				content = strings.TrimSpace(trimmed[2:])
			case strings.HasPrefix(trimmed, "> "):
				prefix = "│ "
				content = strings.TrimSpace(trimmed[2:])
				style = dimStyle.Copy()
			}
			for index, row := range wrapPlainText(content, maxInt(1, width-lipgloss.Width(prefix))) {
				if index == 0 {
					lines = append(lines, dimStyle.Render(prefix)+renderInlineMarkdown(row, style))
					continue
				}
				lines = append(lines, strings.Repeat(" ", lipgloss.Width(prefix))+renderInlineMarkdown(row, style))
			}
		case trimmed == "":
			lines = append(lines, "")
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
		renderMarkdownTableRow(table.Header, columnWidths, baseStyle.Copy().Bold(true)),
		renderMarkdownTableRule("├", "┼", "┤", columnWidths),
	}

	for _, row := range table.Rows {
		lines = append(lines, renderMarkdownTableRow(row, columnWidths, baseStyle))
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

func renderMarkdownTableRow(row []string, widths []int, style lipgloss.Style) string {
	cells := make([]string, 0, len(widths))
	for index, width := range widths {
		value := ""
		if index < len(row) {
			value = strings.TrimSpace(row[index])
		}
		rendered := renderInlineMarkdown(value, style)
		padded := fitToWidth(rendered, width)
		padding := strings.Repeat(" ", maxInt(0, width-lipgloss.Width(padded)))
		cells = append(cells, " "+padded+padding+" ")
	}
	return "│" + strings.Join(cells, "│") + "│"
}

func renderInlineMarkdown(value string, baseStyle lipgloss.Style) string {
	var builder strings.Builder
	parts := strings.Split(value, "`")
	for index, part := range parts {
		if index%2 == 1 {
			builder.WriteString(inlineCodeStyle.Render(part))
			continue
		}
		builder.WriteString(renderInlineEmphasis(part, baseStyle))
	}
	return builder.String()
}

func renderInlineEmphasis(value string, baseStyle lipgloss.Style) string {
	if value == "" {
		return ""
	}

	runes := []rune(value)
	var builder strings.Builder
	for index := 0; index < len(runes); {
		if index+1 < len(runes) {
			switch {
			case runes[index] == '*' && runes[index+1] == '*':
				if end := findInlineMarkerEndString(runes, index+2, "**"); end >= 0 {
					builder.WriteString(baseStyle.Copy().Bold(true).Render(string(runes[index+2 : end])))
					index = end + 2
					continue
				}
			case runes[index] == '_' && runes[index+1] == '_':
				if end := findInlineMarkerEndString(runes, index+2, "__"); end >= 0 {
					builder.WriteString(baseStyle.Copy().Bold(true).Render(string(runes[index+2 : end])))
					index = end + 2
					continue
				}
			}
		}

		switch runes[index] {
		case '*':
			if end := findInlineMarkerEndRune(runes, index+1, '*'); end >= 0 {
				builder.WriteString(baseStyle.Copy().Italic(true).Render(string(runes[index+1 : end])))
				index = end + 1
				continue
			}
		case '_':
			if end := findInlineMarkerEndRune(runes, index+1, '_'); end >= 0 {
				builder.WriteString(baseStyle.Copy().Italic(true).Render(string(runes[index+1 : end])))
				index = end + 1
				continue
			}
		case '~':
			if index+1 < len(runes) && runes[index+1] == '~' {
				if end := findInlineMarkerEndString(runes, index+2, "~~"); end >= 0 {
					builder.WriteString(baseStyle.Copy().Strikethrough(true).Render(string(runes[index+2 : end])))
					index = end + 2
					continue
				}
			}
		}

		builder.WriteString(baseStyle.Render(string(runes[index])))
		index++
	}
	return builder.String()
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

func renderDiffRows(sign, lineNumber, content string, width int) []string {
	signStyle := userStyle
	if sign == "-" {
		signStyle = errorStyle
	}
	prefix := signStyle.Render(sign)
	if lineNumber != "" {
		prefix += " " + dimStyle.Render(fmt.Sprintf("%4s |", lineNumber))
	}
	if content == "" {
		return []string{prefix}
	}

	contentWidth := maxInt(8, width-lipgloss.Width(prefix)-1)
	wrapped := wrapPlainText(content, contentWidth)
	lines := make([]string, 0, len(wrapped))
	for index, row := range wrapped {
		rowPrefix := prefix
		if index > 0 {
			rowPrefix = strings.Repeat(" ", maxInt(1, lipgloss.Width(prefix)))
		}
		lines = append(lines, rowPrefix+" "+renderCodeLine(row))
	}
	return lines
}

func renderCodeLine(value string) string {
	if strings.TrimSpace(value) == "" {
		return value
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
		builder.WriteString(renderCodeToken(token))
	}
	if commentPart != "" {
		builder.WriteString(codeCommentStyle.Render(commentPart))
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
			end := index + 1
			for end < len(runes) {
				next := runes[end]
				if !((next >= '0' && next <= '9') || next == '.') {
					break
				}
				end++
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
	trimmed := strings.TrimSpace(token)
	switch {
	case trimmed == "":
		return token
	case isQuotedCodeToken(token):
		return codeStringStyle.Render(token)
	case isCodeKeyword(trimmed):
		return codeKeywordStyle.Render(token)
	case isNumericToken(trimmed):
		return codeNumberStyle.Render(token)
	default:
		return codePlainStyle.Render(token)
	}
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
		"let", "function", "export", "extends", "implements", "new":
		return true
	default:
		return false
	}
}

func isNumericToken(token string) bool {
	if token == "" {
		return false
	}
	for _, r := range token {
		if (r < '0' || r > '9') && r != '.' {
			return false
		}
	}
	return true
}

func (m *Model) renderActivePanel(width, height int) string {
	switch m.ActivePanel {
	case PanelApprovals:
		return m.renderApprovals(width, height)
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

func (m *Model) renderComposer(width int) string {
	contentWidth := framedInnerWidth(focusedInputBoxStyle, width)
	rows := m.visibleComposerRows(contentWidth)
	promptStyle := promptStyleForStatus(m.Status)
	style := focusedInputBoxStyle
	if m.ActivePanel != PanelNone {
		style = inputBoxStyle
		contentWidth = framedInnerWidth(style, width)
		rows = m.visibleComposerRows(contentWidth)
	}

	lines := make([]string, 0, len(rows)+2)
	for _, row := range rows {
		prefix := "> "
		if row.Continued {
			prefix = "· "
		}

		if row.Placeholder {
			lines = append(lines, promptStyle.Render(prefix)+dimStyle.Render(row.Text))
		} else {
			lines = append(lines, promptStyle.Render(prefix)+row.Text)
		}
	}

	if m.Notice != "" {
		noticeStyle := dimStyle
		if m.NoticeIsError {
			noticeStyle = errorStyle
		}
		for _, line := range wrapPlainText(m.Notice, contentWidth) {
			lines = append(lines, noticeStyle.Render(line))
		}
	} else {
		helper := "Enter send | Ctrl+J newline | Ctrl+U clear | Ctrl+W word | Home/End move | F6 copy/paste mode | /help"
		if !m.MouseCapture {
			helper = "Enter send | Ctrl+J newline | Ctrl+U clear | Ctrl+W word | Home/End move | drag select/copy | right-click paste | F6 restore wheel | /help"
		}
		lines = append(lines, dimStyle.Render(helper))
	}

	if matches := m.composerSlashSuggestions(3); len(matches) > 0 && strings.HasPrefix(strings.TrimSpace(string(m.Input)), "/") {
		best := matches[0]
		bestCommand := truncatePlain(best.Command, maxInt(0, contentWidth-8))
		lines = append(lines, sectionStyle.Render("match  ")+titleStyle.Render(bestCommand))

		bestHintParts := []string{best.Description}
		if argumentHint := slashArgumentHint(best.Command); argumentHint != "" {
			bestHintParts = append(bestHintParts, fmt.Sprintf("args %s", argumentHint))
		}
		if best.InsertValue != "" && best.InsertValue != best.Command {
			bestHintParts = append(bestHintParts, fmt.Sprintf("Tab → %s", strings.TrimSpace(best.InsertValue)))
		}
		lines = append(lines, dimStyle.Render(truncatePlain(strings.Join(bestHintParts, "  |  "), contentWidth)))

		if len(matches) > 1 {
			alternates := make([]string, 0, len(matches)-1)
			for _, item := range matches[1:] {
				alternates = append(alternates, slashAlternateSummary(item))
			}
			lines = append(lines, sectionStyle.Render("also   ")+dimStyle.Render(truncatePlain(strings.Join(alternates, "  |  "), contentWidth-8)))
		}
	}

	return style.
		Width(framedRenderWidth(style, width)).
		MaxWidth(width).
		Render(strings.Join(lines, "\n"))
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

func (m *Model) visibleComposerRows(width int) []composerRow {
	if len(m.Input) == 0 {
		placeholder := "Ask Cyrene, use / commands, or mention files with @..."
		if m.ActivePanel != PanelNone {
			placeholder = fmt.Sprintf("Panel %s active. Esc to close, then continue typing.", m.ActivePanel)
		}
		return []composerRow{{
			Text:        cursorStyle.Render("|") + " " + placeholder,
			Placeholder: true,
		}}
	}

	cursor := clampInt(m.Cursor, 0, len(m.Input))
	before := string(m.Input[:cursor])
	after := string(m.Input[cursor:])
	plain := before + "|" + after
	wrapped := wrapPlainText(plain, maxInt(1, width-2))

	rows := make([]composerRow, 0, len(wrapped))
	for index, row := range wrapped {
		rendered := strings.Replace(row, "|", cursorStyle.Render("|"), 1)
		rows = append(rows, composerRow{Text: rendered, Continued: index > 0})
	}

	if len(rows) <= 6 {
		return rows
	}
	return rows[len(rows)-6:]
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
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("%s  |  %s", selected.Action, truncatePlain(selected.Path, maxInt(8, bodyWidth-16)))))
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("id %s  |  %s", truncatePlain(selected.ID, 14), emptyFallback(selected.CreatedAt, "unknown"))))
	previewSource := selected.PreviewSummary
	if m.ApprovalPreview == ApprovalFull && strings.TrimSpace(selected.PreviewFull) != "" {
		previewSource = selected.PreviewFull
	}
	previewLines := parseApprovalPreviewLines(previewSource)
	previewWindow := previewWindow(previewLines, m.ApprovalPreviewOffset, approvalPreviewPageLines)
	addCount, delCount := approvalDiffStats(previewLines)
	bodyLines = append(bodyLines,
		sectionStyle.Render("preview"),
		dimStyle.Render(fmt.Sprintf("%s  %d-%d/%d  |  +%d -%d", m.ApprovalPreview, previewWindow.Start+1, previewWindow.End, previewWindow.Total, addCount, delCount)),
	)
	previewRendered := make([]string, 0, len(previewWindow.Lines))
	for _, line := range previewWindow.Lines {
		previewRendered = append(previewRendered, renderApprovalPreviewLines(line, bodyWidth)...)
	}
	bodyLines = append(bodyLines, renderScrollableBlock(previewRendered, bodyWidth, panelScrollState{
		Offset:  previewWindow.Start,
		Visible: minInt(previewWindow.Total, approvalPreviewPageLines),
		Total:   previewWindow.Total,
	})...)
	bodyLines = append(bodyLines, dimStyle.Render("j/k scroll  |  a approve  |  r reject"))
	return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
}

func (m *Model) renderSessions(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	page := pageForSelection(len(m.Sessions), m.SessionIndex, m.sessionPanelPageSizeForDimensions(width, height))
	headerLines := []string{
		renderPanelHeaderColumns(bodyWidth, "sel ↑/↓", "page ←/→", "load ↵", "new n", "refresh r", "esc"),
	}
	footerLines := []string{renderPanelSummaryColumns(bodyWidth, "sessions", fmt.Sprintf("page %d/%d", page.CurrentPage, page.TotalPages), fmt.Sprintf("total %d", page.Total))}
	bodyLines := []string{}
	if len(m.Sessions) == 0 {
		bodyLines = append(bodyLines, dimStyle.Render("No saved sessions."))
		return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
	}
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
	selected := m.Sessions[clampInt(m.SessionIndex, 0, len(m.Sessions)-1)]
	bodyLines = append(bodyLines, "", sectionStyle.Render("detail"))
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("id %s", selected.ID)))
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("updated %s", selected.UpdatedAt)))
	if strings.TrimSpace(selected.ProjectRoot) != "" {
		bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("project %s", truncatePlain(selected.ProjectRoot, bodyWidth-8))))
	} else {
		bodyLines = append(bodyLines, dimStyle.Render("project none"))
	}
	if len(selected.Tags) > 0 {
		bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("tags %s", strings.Join(selected.Tags, ", "))))
	} else {
		bodyLines = append(bodyLines, dimStyle.Render("tags none"))
	}
	return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
}

func (m *Model) renderModels(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	page := pageForSelection(len(m.AvailableModels), m.ModelIndex, m.modelPanelPageSizeForDimensions(width, height))
	headerLines := []string{
		renderPanelHeaderColumns(bodyWidth, "sel ↑/↓", "page ←/→", "switch ↵", "refresh r", "esc"),
	}
	footerLines := []string{renderPanelSummaryColumns(bodyWidth, "models", fmt.Sprintf("page %d/%d", page.CurrentPage, page.TotalPages), fmt.Sprintf("total %d", page.Total))}
	bodyLines := []string{}
	if len(m.AvailableModels) == 0 {
		bodyLines = append(bodyLines, dimStyle.Render("No models available."))
		return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
	}
	bodyLines = append(bodyLines, sectionStyle.Render("list"))
	listLines := make([]string, 0, maxInt(1, (page.End-page.Start)*2))
	for index := page.Start; index < page.End; index++ {
		model := m.AvailableModels[index]
		prefix := "  "
		style := lipgloss.NewStyle()
		if index == m.ModelIndex {
			prefix = "> "
			style = asstStyle.Bold(true)
		}
		marker := ""
		if model == m.CurrentModel {
			marker = " [current]"
		}
		listLines = append(listLines, style.Render(fmt.Sprintf("%s%s%s", prefix, truncatePlain(model, bodyWidth-20), marker)))
		listLines = append(listLines, dimStyle.Render(fmt.Sprintf("   family %s", modelFamily(model))))
	}
	bodyLines = append(bodyLines, renderScrollableBlock(listLines, bodyWidth, panelScrollState{
		Offset:  maxInt(0, page.CurrentPage-1),
		Visible: 1,
		Total:   maxInt(1, page.TotalPages),
	})...)
	selected := m.AvailableModels[clampInt(m.ModelIndex, 0, len(m.AvailableModels)-1)]
	bodyLines = append(bodyLines, "", sectionStyle.Render("detail"))
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("selected %s", selected)))
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("family %s", modelFamily(selected))))
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("provider %s", truncatePlain(emptyFallback(m.CurrentProvider, "none"), bodyWidth))))
	return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
}

func (m *Model) renderProviders(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	page := pageForSelection(len(m.AvailableProviders), m.ProviderIndex, m.providerPanelPageSizeForDimensions(width, height))
	headerLines := []string{
		renderPanelHeaderColumns(bodyWidth, "sel ↑/↓", "page ←/→", "switch ↵", "refresh r", "esc"),
	}
	footerLines := []string{renderPanelSummaryColumns(bodyWidth, "providers", fmt.Sprintf("page %d/%d", page.CurrentPage, page.TotalPages), fmt.Sprintf("total %d", page.Total))}
	bodyLines := []string{}
	for _, row := range wrapPlainText("provider profile commands: /provider profile list | /provider profile <profile> [url]", bodyWidth) {
		bodyLines = append(bodyLines, dimStyle.Render(row))
	}
	for _, row := range wrapPlainText("provider type commands: /provider type list | /provider type <type> [url]", bodyWidth) {
		bodyLines = append(bodyLines, dimStyle.Render(row))
	}
	for _, row := range wrapPlainText("provider format commands: /provider format list | /provider format <format> [url]", bodyWidth) {
		bodyLines = append(bodyLines, dimStyle.Render(row))
	}
	for _, row := range wrapPlainText("provider endpoint commands: /provider endpoint list | /provider endpoint <kind> <path|url> [provider]", bodyWidth) {
		bodyLines = append(bodyLines, dimStyle.Render(row))
	}
	for _, row := range wrapPlainText("endpoint kinds: responses | chat_completions | models | anthropic_messages | gemini_generate_content", bodyWidth) {
		bodyLines = append(bodyLines, dimStyle.Render(row))
	}
	for _, row := range wrapPlainText("provider name commands: /provider name <display_name> | /provider name list | /provider name clear [url]", bodyWidth) {
		bodyLines = append(bodyLines, dimStyle.Render(row))
	}
	if len(m.AvailableProviders) == 0 {
		bodyLines = append(bodyLines, dimStyle.Render("No providers available."))
		return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
	}
	bodyLines = append(bodyLines, sectionStyle.Render("list"))
	listLines := make([]string, 0, maxInt(1, (page.End-page.Start)*3))
	for index := page.Start; index < page.End; index++ {
		provider := m.AvailableProviders[index]
		prefix := "  "
		style := lipgloss.NewStyle()
		if index == m.ProviderIndex {
			prefix = "> "
			style = asstStyle.Bold(true)
		}
		marker := ""
		if provider == m.CurrentProvider {
			marker = " [current]"
		}
		name := m.providerDisplayName(provider)
		profile := formatProviderProfileLabel(m.providerProfile(provider))
		format := formatTransportFormatLabel(m.providerFormat(provider))
		source := formatProviderProfileSourceLabel(m.providerProfileSource(provider))
		listLines = append(listLines, style.Render(fmt.Sprintf("%s%s%s", prefix, truncatePlain(name, bodyWidth-20), marker)))
		listLines = append(listLines, dimStyle.Render(fmt.Sprintf("   endpoint %s  |  source %s", truncatePlain(formatProviderLabel(provider, maxInt(8, bodyWidth-30)), maxInt(8, bodyWidth-4)), source)))
		listLines = append(listLines, dimStyle.Render(fmt.Sprintf("   profile %s  |  format %s", profile, format)))
	}
	bodyLines = append(bodyLines, renderScrollableBlock(listLines, bodyWidth, panelScrollState{
		Offset:  maxInt(0, page.CurrentPage-1),
		Visible: 1,
		Total:   maxInt(1, page.TotalPages),
	})...)
	selected := m.AvailableProviders[clampInt(m.ProviderIndex, 0, len(m.AvailableProviders)-1)]
	bodyLines = append(bodyLines, "", sectionStyle.Render("detail"))
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("selected %s", m.providerDisplayName(selected))))
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("url %s", truncatePlain(selected, bodyWidth-4))))
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("profile %s  |  source %s", formatProviderProfileLabel(m.providerProfile(selected)), formatProviderProfileSourceLabel(m.providerProfileSource(selected)))))
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("format %s  |  host %s", formatTransportFormatLabel(m.providerFormat(selected)), providerEndpointKind(selected, m.providerProfile(selected)))))
	for _, line := range m.providerEndpointDetailLines(selected, bodyWidth) {
		bodyLines = append(bodyLines, dimStyle.Render(line))
	}
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("key %s", formatKeySourceLabel(m.CurrentProviderKeySource))))
	return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
}

func (m *Model) renderAuthPanel(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	stepLabel := strings.ToUpper(strings.ReplaceAll(string(m.AuthStep), "_", " "))
	headerLines := []string{
		renderPanelHeaderColumns(bodyWidth, "1/2/3/4 jump", "tab/↑/↓ step", "enter next/connect", "esc close"),
	}
	footerLines := []string{renderPanelSummaryColumns(bodyWidth, "auth", "step "+stepLabel)}
	bodyLines := []string{}

	providerLine := formatAuthFieldLine(1, "Provider", string(m.AuthProvider), m.AuthStep == AuthStepProvider)
	typeLine := formatAuthFieldLine(2, "Provider Type", string(m.AuthProviderType), m.AuthStep == AuthStepProviderType)
	apiLine := formatAuthFieldLine(3, "API Key", maskSecret(string(m.AuthAPIKey)), m.AuthStep == AuthStepAPIKey)
	modelLine := formatAuthFieldLine(4, "Model", emptyFallback(strings.TrimSpace(string(m.AuthModel)), m.CurrentModel), m.AuthStep == AuthStepModel)
	confirmLine := "[5] Confirm and connect"
	if m.AuthStep == AuthStepConfirm {
		confirmLine = asstStyle.Bold(true).Render(confirmLine)
	}
	bodyLines = append(bodyLines, sectionStyle.Render("fields"), providerLine, typeLine, apiLine, modelLine, confirmLine)
	bodyLines = append(bodyLines, dimStyle.Render(fmt.Sprintf("Current mode: %s  |  persistence: %s", emptyFallback(m.Auth.Mode, "local"), emptyFallback(m.Auth.PersistenceLabel, "unavailable"))))
	if strings.TrimSpace(m.Auth.PersistencePath) != "" {
		bodyLines = append(bodyLines, dimStyle.Render(truncatePlain(m.Auth.PersistencePath, bodyWidth)))
	}

	if m.AuthStep == AuthStepConfirm {
		bodyLines = append(bodyLines, "", sectionStyle.Render("detail"), dimStyle.Render("Press Enter to save login and rebuild the transport."))
	} else {
		bodyLines = append(bodyLines, "", sectionStyle.Render("editor"))
		for _, row := range m.authEditorLines(bodyWidth) {
			bodyLines = append(bodyLines, row)
		}
	}
	if m.AuthSaving {
		bodyLines = append(bodyLines, reviewStyle.Render("Saving login..."))
	}
	return renderPanelBox(width, height, bodyWidth, bodyHeight, headerLines, bodyLines, footerLines)
}

func formatAuthFieldLine(index int, label, value string, selected bool) string {
	line := fmt.Sprintf("[%d] %s  %s", index, label, emptyFallback(strings.TrimSpace(value), "(empty)"))
	if selected {
		return asstStyle.Bold(true).Render(line)
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
		lines = append(lines, truncatePlain(label, maxInt(8, bodyWidth-4)))
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

func renderApprovalPreviewLines(line approvalPreviewLine, width int) []string {
	maxWidth := maxInt(1, width)
	switch line.Kind {
	case "section":
		return []string{dimStyle.Bold(true).Render(truncatePlain("== "+emptyFallback(line.Section, "preview")+" ==", maxWidth))}
	case "hunk":
		return []string{asstStyle.Bold(true).Render(truncatePlain(line.Text, maxWidth))}
	case "add":
		return renderTerminalDiffRows("+", line.LineNumber, emptyFallback(line.Content, line.Text), maxWidth, userStyle)
	case "remove":
		return renderTerminalDiffRows("-", line.LineNumber, emptyFallback(line.Content, line.Text), maxWidth, errorStyle)
	case "kv":
		keyPrefix := dimStyle.Render(line.Key + ": ")
		valueWidth := maxInt(1, maxWidth-lipgloss.Width(line.Key)-2)
		wrapped := wrapPlainText(line.Val, valueWidth)
		if len(wrapped) == 0 {
			return []string{truncatePlain(keyPrefix, maxWidth)}
		}
		lines := make([]string, 0, len(wrapped))
		for index, row := range wrapped {
			if index == 0 {
				lines = append(lines, truncatePlain(keyPrefix+asstStyle.Render(row), maxWidth))
				continue
			}
			lines = append(lines, truncatePlain(strings.Repeat(" ", lipgloss.Width(line.Key)+2)+asstStyle.Render(row), maxWidth))
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

func renderTerminalDiffRows(sign, lineNumber, content string, width int, style lipgloss.Style) []string {
	gutter := sign
	if strings.TrimSpace(lineNumber) != "" {
		gutter = fmt.Sprintf("%s %4s │", sign, lineNumber)
	}
	contentWidth := maxInt(1, width-lipgloss.Width(gutter)-1)
	wrapped := wrapPlainText(content, contentWidth)
	if len(wrapped) == 0 {
		wrapped = []string{""}
	}
	lines := make([]string, 0, len(wrapped))
	continuation := strings.Repeat(" ", maxInt(1, lipgloss.Width(gutter)))
	for index, row := range wrapped {
		left := gutter
		if index > 0 {
			left = continuation
		}
		lines = append(lines, style.Render(left+" "+renderCodeLine(row)))
	}
	return lines
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
			wrapped = append(wrapped, fitDisplayWidth(line, width))
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
			wrappedRows = []string{fitDisplayWidth(line, width)}
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
			wrappedRows = []string{fitDisplayWidth(line, width)}
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
	contentWidth := maxInt(1, width-2)
	thumbStart, thumbSize := scrollbarThumb(scroll, len(lines))
	rendered := make([]string, 0, len(lines))
	for index, line := range lines {
		base := fitDisplayWidth(line, contentWidth)
		glyph := scrollbarTrackStyle().Render("│")
		if index >= thumbStart && index < thumbStart+thumbSize {
			glyph = scrollbarThumbStyle().Render("█")
		}
		rendered = append(rendered, base+" "+glyph)
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
	return dimStyle.Copy().Foreground(lipgloss.Color("15"))
}

func scrollbarThumbStyle() lipgloss.Style {
	return asstStyle.Copy().Foreground(lipgloss.Color("11")).Bold(true)
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
	if lipgloss.Width(value) <= width {
		return value
	}
	if width == 1 {
		return "~"
	}
	runes := []rune(value)
	for len(runes) > 0 && lipgloss.Width(string(runes))+1 > width {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + "~"
}

func fitDisplayWidth(value string, width int) string {
	if width <= 0 {
		return ""
	}
	truncated := ansi.Truncate(value, width, "")
	padding := maxInt(0, width-ansi.StringWidth(truncated))
	if padding == 0 {
		return truncated
	}
	return truncated + strings.Repeat(" ", padding)
}

func truncateMiddlePlain(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if lipgloss.Width(value) <= width {
		return value
	}
	if width <= 3 {
		return strings.Repeat(".", width)
	}

	runes := []rune(value)
	leftBudget := (width - 3) / 2
	rightBudget := width - 3 - leftBudget

	left := make([]rune, 0, leftBudget)
	leftWidth := 0
	for _, r := range runes {
		rw := lipgloss.Width(string(r))
		if leftWidth+rw > leftBudget {
			break
		}
		left = append(left, r)
		leftWidth += rw
	}

	right := make([]rune, 0, rightBudget)
	rightWidth := 0
	for index := len(runes) - 1; index >= 0; index-- {
		rw := lipgloss.Width(string(runes[index]))
		if rightWidth+rw > rightBudget {
			break
		}
		right = append([]rune{runes[index]}, right...)
		rightWidth += rw
	}

	return string(left) + "..." + string(right)
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

		var current []rune
		currentWidth := 0
		for _, r := range segment {
			rw := lipgloss.Width(string(r))
			if currentWidth+rw > width && len(current) > 0 {
				lines = append(lines, string(current))
				current = current[:0]
				currentWidth = 0
			}
			current = append(current, r)
			currentWidth += rw
		}
		if len(current) > 0 {
			lines = append(lines, string(current))
		}
	}

	if len(lines) == 0 {
		return []string{""}
	}
	return lines
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

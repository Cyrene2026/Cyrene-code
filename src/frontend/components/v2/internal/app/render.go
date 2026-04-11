package app

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

var (
	rootStyle = lipgloss.NewStyle().Padding(0, 1)

	brandChipStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("0")).
			Background(lipgloss.Color("14")).
			Padding(0, 1)

	titleStyle     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("13"))
	dimStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	errorStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	userStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	asstStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("14"))
	reviewStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	systemStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	sectionStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("14"))
	codeBlockStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("7")).
			Background(lipgloss.Color("0")).
			Padding(0, 1)
	inlineCodeStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("14")).
			Background(lipgloss.Color("0")).
			Padding(0, 1)
	codeFenceStyle   = dimStyle.Copy().Italic(true)
	codeKeywordStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("13")).Bold(true)
	codeStringStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	codeCommentStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("8")).Italic(true)
	codeNumberStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	codePlainStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("7"))

	inputBoxStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("8")).
			Padding(0, 1)

	focusedInputBoxStyle = inputBoxStyle.Copy().
				BorderForeground(lipgloss.Color("14"))

	panelBoxStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("8")).
			Padding(0, 1)

	cursorStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("14"))
)

var startupShadowLogoLines = []string{
	"██╗   ██████╗██╗   ██╗██████╗ ███████╗███╗   ██╗███████╗",
	"╚██╗ ██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝████╗  ██║██╔════╝",
	" ╚██╗██║      ╚████╔╝ ██████╔╝█████╗  ██╔██╗ ██║█████╗  ",
	" ██╔╝██║       ╚██╔╝  ██╔══██╗██╔══╝  ██║╚██╗██║██╔══╝  ",
	"██╔╝ ╚██████╗   ██║   ██║  ██║███████╗██║ ╚████║███████╗",
	"╚═╝   ╚═════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝╚══════╝",
}

var (
	diffPattern         = regexp.MustCompile(`^([+-])\s*(\d+)?\s*\|\s?(.*)$`)
	numberedDiffPattern = regexp.MustCompile(`^\s*(\d+)\s*\|\s?(.*)$`)
	kvPattern           = regexp.MustCompile(`^([a-z][a-z0-9_ ]*):\s*(.*)$`)
	headerKVPattern     = regexp.MustCompile(`^[a-z_]+=.*$`)
)

func (m *Model) View() string {
	width := maxInt(50, m.Width)
	height := maxInt(18, m.Height)
	contentWidth := maxInt(30, width-2)

	header := m.renderHeader(contentWidth)
	panel := ""
	panelHeight := m.panelHeight()
	if panelHeight > 0 {
		panel = m.renderActivePanel(contentWidth, panelHeight)
	}
	statusLine := m.renderStatusLine(contentWidth)
	composer := m.renderComposer(contentWidth)

	fixedHeight := lipgloss.Height(header) + panelHeight + lipgloss.Height(statusLine) + lipgloss.Height(composer)
	transcriptHeight := maxInt(3, height-fixedHeight-1)
	transcript := m.renderTranscript(contentWidth, transcriptHeight)

	parts := []string{header, transcript}
	if panel != "" {
		parts = append(parts, panel)
	}
	parts = append(parts, statusLine, composer)
	return rootStyle.Width(width).Height(height).Render(strings.Join(parts, "\n"))
}

func (m *Model) panelHeight() int {
	switch m.ActivePanel {
	case PanelApprovals:
		return 16
	case PanelAuth:
		return 12
	case PanelSessions, PanelModels, PanelProviders:
		return 12
	default:
		return 0
	}
}

func (m *Model) renderHeader(width int) string {
	badge := statusBadgeStyle(m.Status).Render(" " + strings.ToUpper(string(statusLabel(m.Status))) + " ")
	title := lipgloss.JoinHorizontal(
		lipgloss.Left,
		brandChipStyle.Render(" >Cyrene "),
		titleStyle.Render(" Code"),
		badge,
	)

	meta := fmt.Sprintf(
		"cwd %s  |  session %s  |  model %s  |  provider %s",
		emptyFallback(m.AppRoot, "none"),
		emptyFallback(m.ActiveSessionID, "none"),
		emptyFallback(m.CurrentModel, "none"),
		emptyFallback(m.CurrentProvider, "none"),
	)
	projectPath := fmt.Sprintf("project %s", emptyFallback(m.AppRoot, "none"))
	help := "/help  /login  /provider  /model  /sessions  /resume  /review  Esc close panel"

	return lipgloss.JoinVertical(
		lipgloss.Left,
		fitToWidth(title, width),
		dimStyle.Render(truncatePlain(meta, width)),
		dimStyle.Render(truncatePlain(projectPath, width)),
		dimStyle.Render(truncatePlain(help, width)),
	)
}

func fitToWidth(value string, width int) string {
	return lipgloss.NewStyle().MaxWidth(width).Render(value)
}

func (m *Model) renderTranscript(width, height int) string {
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
	lines = append(lines, window...)
	for len(lines) < height {
		lines = append(lines, "")
	}
	return strings.Join(lines, "\n")
}

func (m *Model) renderTranscriptLines(width int) []string {
	if m.transcriptCacheWidth == width && m.transcriptCacheVersion == m.transcriptVersion && m.transcriptCacheLines != nil {
		return m.transcriptCacheLines
	}

	if m.shouldShowStartupView() {
		lines := m.renderStartupLines(width)
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
		if index < len(items)-1 {
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
	lines = append(lines, asstStyle.Bold(true).Render(">Cyrene"))
	lines = append(lines, "")
	for index, line := range startupShadowLogoLines {
		if index%2 == 0 {
			lines = append(lines, asstStyle.Bold(true).Render(truncatePlain(line, width)))
		} else {
			lines = append(lines, reviewStyle.Bold(true).Render(truncatePlain(line, width)))
		}
	}

	lines = append(lines,
		"",
		titleStyle.Bold(true).Render("Cyrene Code"),
		dimStyle.Render("Terminal-first coding assistant for the current workspace."),
		dimStyle.Render(truncatePlain(fmt.Sprintf("mode %s  |  model %s  |  provider %s", emptyFallback(m.Auth.Mode, "local"), emptyFallback(m.CurrentModel, "none"), emptyFallback(m.CurrentProvider, "none")), width)),
		dimStyle.Render(truncatePlain(fmt.Sprintf("session %s  |  pending %d", emptyFallback(m.ActiveSessionID, "none"), len(m.PendingReviews)), width)),
		"",
		reviewStyle.Bold(true).Render("Start here"),
		"> Explain this repository  - summarize structure, stack, or one file.",
		"> Fix something  - point to failing behavior and let Cyrene patch it.",
		"> Connect HTTP  - use /login to save credentials.",
		"> Continue  - use /sessions, /review, /model, or /provider.",
		"",
		"Use /help for full command reference.",
	)
	return wrapLinesToWidth(lines, width)
}

func renderMessageLines(message Message, width int) []string {
	label, labelStyle, contentStyle := messageStyles(message)
	bodyWidth := maxInt(1, width-2)
	renderedBody := renderMarkdownBodyLines(message.Text, bodyWidth, contentStyle)
	lines := make([]string, 0, len(renderedBody)+1)
	lines = append(lines, labelStyle.Render(label))
	for _, row := range renderedBody {
		lines = append(lines, row)
	}
	return lines
}

func renderMarkdownBodyLines(value string, width int, baseStyle lipgloss.Style) []string {
	if width <= 0 {
		return []string{""}
	}

	rawLines := strings.Split(value, "\n")
	lines := make([]string, 0, len(rawLines))
	inCodeBlock := false

	for _, raw := range rawLines {
		trimmed := strings.TrimSpace(raw)
		if strings.HasPrefix(trimmed, "```") {
			inCodeBlock = !inCodeBlock
			lang := strings.TrimSpace(strings.TrimPrefix(trimmed, "```"))
			if lang != "" {
				lines = append(lines, "  "+codeFenceStyle.Render("code "+lang))
			}
			continue
		}

		if inCodeBlock {
			wrapped := wrapPlainText(raw, maxInt(1, width-2))
			if len(wrapped) == 0 {
				lines = append(lines, "  "+codeBlockStyle.Render(""))
				continue
			}
			for _, row := range wrapped {
				lines = append(lines, "  "+codeBlockStyle.Render(renderCodeLine(row)))
			}
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
				lines = append(lines, "  "+asstStyle.Bold(true).Render(row))
			}
		case strings.HasPrefix(trimmed, "[diff preview]"),
			strings.HasPrefix(trimmed, "[create preview"),
			strings.HasPrefix(trimmed, "[write preview"),
			strings.HasPrefix(trimmed, "[edit preview"),
			strings.HasPrefix(trimmed, "[patch preview"),
			strings.HasPrefix(trimmed, "[old -"),
			strings.HasPrefix(trimmed, "[new +"):
			for _, row := range wrapPlainText(raw, width) {
				lines = append(lines, "  "+sectionStyle.Render(row))
			}
		case strings.HasPrefix(trimmed, "#"):
			heading := strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
			for _, row := range wrapPlainText(heading, width) {
				lines = append(lines, "  "+titleStyle.Bold(true).Render(row))
			}
		case strings.HasPrefix(trimmed, "- "),
			strings.HasPrefix(trimmed, "* "),
			strings.HasPrefix(trimmed, "> "):
			for _, row := range wrapPlainText(raw, width) {
				lines = append(lines, "  "+renderInlineMarkdown(row, baseStyle))
			}
		default:
			for _, row := range wrapPlainText(raw, width) {
				lines = append(lines, "  "+renderInlineMarkdown(row, baseStyle))
			}
		}
	}

	if len(lines) == 0 {
		return []string{"  "}
	}
	return lines
}

func renderInlineMarkdown(value string, baseStyle lipgloss.Style) string {
	if !strings.Contains(value, "`") {
		return baseStyle.Render(value)
	}

	parts := strings.Split(value, "`")
	if len(parts) < 3 {
		return baseStyle.Render(value)
	}

	var builder strings.Builder
	for index, part := range parts {
		if index%2 == 1 {
			builder.WriteString(inlineCodeStyle.Render(part))
			continue
		}
		if part == "" {
			continue
		}
		builder.WriteString(baseStyle.Render(part))
	}
	return builder.String()
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
		return []string{"  " + prefix}
	}

	contentWidth := maxInt(8, width-lipgloss.Width(prefix)-1)
	wrapped := wrapPlainText(content, contentWidth)
	lines := make([]string, 0, len(wrapped))
	for index, row := range wrapped {
		rowPrefix := prefix
		if index > 0 {
			rowPrefix = strings.Repeat(" ", maxInt(1, lipgloss.Width(prefix)))
		}
		lines = append(lines, "  "+rowPrefix+" "+renderCodeLine(row))
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
	line := fmt.Sprintf(
		"mode %s  |  key %s  |  pending %d  |  panel %s",
		emptyFallback(m.Auth.Mode, "local"),
		formatKeySourceLabel(m.CurrentProviderKeySource),
		len(m.PendingReviews),
		emptyFallback(string(m.ActivePanel), "none"),
	)
	return dimStyle.Render(truncatePlain(line, width))
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
		lines = append(lines, dimStyle.Render("Enter send | Ctrl+J newline | PgUp/PgDn transcript | /help"))
	}

	if m.ActivePanel == PanelNone {
		suggestions := suggestSlashCommands(string(m.Input), 3)
		if len(suggestions) > 0 {
			lines = append(lines, dimStyle.Render("commands"))
			for _, item := range suggestions {
				for _, row := range wrapPlainText(fmt.Sprintf("  %s - %s", item.Command, item.Description), contentWidth) {
					lines = append(lines, dimStyle.Render(row))
				}
			}
		}
	}

	return style.
		Width(contentWidth).
		MaxWidth(width).
		Render(strings.Join(lines, "\n"))
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
	lines := []string{
		reviewStyle.Bold(true).Render(fmt.Sprintf("[review]  page %d/%d  total %d", page.CurrentPage, page.TotalPages, page.Total)),
		dimStyle.Render("Up/Down: select  Left/Right: page  Tab: summary/full  j/k or PgUp/PgDn: preview scroll  a: approve  r/d: reject  Esc: close"),
	}

	if len(m.PendingReviews) == 0 {
		lines = append(lines, dimStyle.Render("No pending approvals."))
		return panelBoxStyle.Width(bodyWidth).Height(bodyHeight).Render(limitBoxLines(lines, bodyWidth, bodyHeight))
	}

	selected := m.PendingReviews[m.ApprovalIndex]
	lines = append(lines, dimStyle.Render(fmt.Sprintf("action %s  |  path %s  |  id %s", selected.Action, truncatePlain(selected.Path, maxInt(12, bodyWidth-34)), selected.ID)))
	lines = append(lines, sectionStyle.Render("[queue]"))
	for index := page.Start; index < page.End; index++ {
		item := m.PendingReviews[index]
		prefix := "  "
		lineStyle := lipgloss.NewStyle()
		if index == m.ApprovalIndex {
			prefix = "> "
			lineStyle = asstStyle.Bold(true)
		}
		line := fmt.Sprintf("%s%s  %s", prefix, actionBadge(item.Action), truncatePlain(item.Path, maxInt(10, bodyWidth-20)))
		lines = append(lines, lineStyle.Render(line))
	}

	lines = append(lines, "")
	lines = append(lines, sectionStyle.Render("[selection]"))
	lines = append(lines, dimStyle.Render(describeApprovalAction(selected.Action)))
	lines = append(lines, dimStyle.Render(fmt.Sprintf("created %s", emptyFallback(selected.CreatedAt, "unknown"))))
	previewSource := selected.PreviewSummary
	if m.ApprovalPreview == ApprovalFull && strings.TrimSpace(selected.PreviewFull) != "" {
		previewSource = selected.PreviewFull
	}
	previewLines := parseApprovalPreviewLines(previewSource)
	previewWindow := previewWindow(previewLines, m.ApprovalPreviewOffset, approvalPreviewPageLines)
	addCount, delCount := approvalDiffStats(previewLines)
	lines = append(lines,
		sectionStyle.Render("[preview]"),
		dimStyle.Render(fmt.Sprintf("%s  %d-%d/%d  |  +%d -%d", m.ApprovalPreview, previewWindow.Start+1, previewWindow.End, previewWindow.Total, addCount, delCount)),
	)
	for _, line := range previewWindow.Lines {
		lines = append(lines, renderApprovalPreviewLine(line, bodyWidth))
	}
	lines = append(lines, dimStyle.Render("Tab preview  |  a approve  |  r/d reject  |  j/k scroll  |  Esc close"))

	return panelBoxStyle.Width(bodyWidth).Height(bodyHeight).Render(limitBoxLines(lines, bodyWidth, bodyHeight))
}

func (m *Model) renderSessions(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	page := pageForSelection(len(m.Sessions), m.SessionIndex, sessionPanelPageSize)
	lines := []string{
		asstStyle.Bold(true).Render(fmt.Sprintf("Sessions  page %d/%d  total %d", page.CurrentPage, page.TotalPages, page.Total)),
		dimStyle.Render("Up/Down: select  Left/Right: page  Enter: load  n: new  r: refresh  Esc: close"),
	}
	if len(m.Sessions) == 0 {
		lines = append(lines, dimStyle.Render("No saved sessions."))
		return panelBoxStyle.Width(bodyWidth).Height(bodyHeight).Render(limitBoxLines(lines, bodyWidth, bodyHeight))
	}
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
		lines = append(lines, style.Render(fmt.Sprintf("%s%s%s", prefix, truncatePlain(session.Title, bodyWidth-16), marker)))
		lines = append(lines, dimStyle.Render("   "+truncatePlain(session.UpdatedAt, bodyWidth-6)))
	}
	selected := m.Sessions[clampInt(m.SessionIndex, 0, len(m.Sessions)-1)]
	lines = append(lines, "", sectionStyle.Render("[preview]"))
	lines = append(lines, dimStyle.Render(fmt.Sprintf("id %s", selected.ID)))
	lines = append(lines, dimStyle.Render(fmt.Sprintf("updated %s", selected.UpdatedAt)))
	return panelBoxStyle.Width(bodyWidth).Height(bodyHeight).Render(limitBoxLines(lines, bodyWidth, bodyHeight))
}

func (m *Model) renderModels(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	page := pageForSelection(len(m.AvailableModels), m.ModelIndex, modelPanelPageSize)
	lines := []string{
		asstStyle.Bold(true).Render(fmt.Sprintf("Models  page %d/%d  total %d", page.CurrentPage, page.TotalPages, page.Total)),
		dimStyle.Render("Up/Down: select  Left/Right: page  Enter: switch  r: refresh  Esc: close"),
	}
	if len(m.AvailableModels) == 0 {
		lines = append(lines, dimStyle.Render("No models available."))
		return panelBoxStyle.Width(bodyWidth).Height(bodyHeight).Render(limitBoxLines(lines, bodyWidth, bodyHeight))
	}
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
		lines = append(lines, style.Render(fmt.Sprintf("%s%s%s", prefix, truncatePlain(model, bodyWidth-20), marker)))
		lines = append(lines, dimStyle.Render(fmt.Sprintf("   family %s  |  provider %s", modelFamily(model), truncatePlain(emptyFallback(m.CurrentProvider, "none"), maxInt(8, bodyWidth-40)))))
	}
	return panelBoxStyle.Width(bodyWidth).Height(bodyHeight).Render(limitBoxLines(lines, bodyWidth, bodyHeight))
}

func (m *Model) renderProviders(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	page := pageForSelection(len(m.AvailableProviders), m.ProviderIndex, providerPanelPageSize)
	lines := []string{
		asstStyle.Bold(true).Render(fmt.Sprintf("Providers  page %d/%d  total %d", page.CurrentPage, page.TotalPages, page.Total)),
		dimStyle.Render("Up/Down: select  Left/Right: page  Enter: switch  r: refresh  Esc: close"),
	}
	for _, row := range wrapPlainText("provider profile commands: /provider profile list | /provider profile <profile> [url]", bodyWidth) {
		lines = append(lines, dimStyle.Render(row))
	}
	if len(m.AvailableProviders) == 0 {
		lines = append(lines, dimStyle.Render("No providers available."))
		return panelBoxStyle.Width(bodyWidth).Height(bodyHeight).Render(limitBoxLines(lines, bodyWidth, bodyHeight))
	}
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
		profile := formatProviderProfileLabel(m.providerProfile(provider))
		source := formatProviderProfileSourceLabel(m.providerProfileSource(provider))
		endpoint := providerEndpointKind(provider, m.providerProfile(provider))
		lines = append(lines, style.Render(fmt.Sprintf("%s%s%s", prefix, truncatePlain(formatProviderLabel(provider, maxInt(8, bodyWidth-18)), bodyWidth-20), marker)))
		lines = append(lines, dimStyle.Render(fmt.Sprintf("   profile %s  |  source %s  |  endpoint %s", profile, source, endpoint)))
	}
	selected := m.AvailableProviders[clampInt(m.ProviderIndex, 0, len(m.AvailableProviders)-1)]
	lines = append(lines, "", sectionStyle.Render("[preview]"))
	lines = append(lines, dimStyle.Render(fmt.Sprintf("selected %s", selected)))
	lines = append(lines, dimStyle.Render(fmt.Sprintf("profile %s  |  source %s", formatProviderProfileLabel(m.providerProfile(selected)), formatProviderProfileSourceLabel(m.providerProfileSource(selected)))))
	lines = append(lines, dimStyle.Render(fmt.Sprintf("key source %s", formatKeySourceLabel(m.CurrentProviderKeySource))))
	return panelBoxStyle.Width(bodyWidth).Height(bodyHeight).Render(limitBoxLines(lines, bodyWidth, bodyHeight))
}

func (m *Model) renderAuthPanel(width, height int) string {
	bodyWidth := framedInnerWidth(panelBoxStyle, width)
	bodyHeight := framedInnerHeight(panelBoxStyle, height)
	lines := []string{
		asstStyle.Bold(true).Render("HTTP Login"),
		dimStyle.Render("1/2/3 jump fields  |  Enter next/connect  |  Tab/Up/Down switch step  |  Esc close"),
	}

	providerLine := formatAuthFieldLine(1, "Provider", string(m.AuthProvider), m.AuthStep == AuthStepProvider)
	apiLine := formatAuthFieldLine(2, "API Key", maskSecret(string(m.AuthAPIKey)), m.AuthStep == AuthStepAPIKey)
	modelLine := formatAuthFieldLine(3, "Model", emptyFallback(strings.TrimSpace(string(m.AuthModel)), m.CurrentModel), m.AuthStep == AuthStepModel)
	confirmLine := "[4] Confirm and connect"
	if m.AuthStep == AuthStepConfirm {
		confirmLine = asstStyle.Bold(true).Render(confirmLine)
	}
	lines = append(lines, providerLine, apiLine, modelLine, confirmLine)
	lines = append(lines, dimStyle.Render(fmt.Sprintf("Current mode: %s  |  persistence: %s", emptyFallback(m.Auth.Mode, "local"), emptyFallback(m.Auth.PersistenceLabel, "unavailable"))))
	if strings.TrimSpace(m.Auth.PersistencePath) != "" {
		lines = append(lines, dimStyle.Render(truncatePlain(m.Auth.PersistencePath, bodyWidth)))
	}

	if m.AuthStep == AuthStepConfirm {
		lines = append(lines, "", dimStyle.Render("Press Enter to save login and rebuild the transport."))
	} else {
		lines = append(lines, "")
		for _, row := range m.authEditorLines(bodyWidth) {
			lines = append(lines, row)
		}
	}
	if m.AuthSaving {
		lines = append(lines, reviewStyle.Render("Saving login..."))
	}
	return panelBoxStyle.Width(bodyWidth).Height(bodyHeight).Render(limitBoxLines(lines, bodyWidth, bodyHeight))
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

func renderApprovalPreviewLine(line approvalPreviewLine, width int) string {
	maxWidth := maxInt(1, width)
	switch line.Kind {
	case "section":
		return dimStyle.Bold(true).Render(truncatePlain("[section] "+emptyFallback(line.Section, "preview"), maxWidth))
	case "hunk":
		return asstStyle.Bold(true).Render(truncatePlain(line.Text, maxWidth))
	case "add":
		label := "+"
		if strings.TrimSpace(line.LineNumber) != "" {
			label = fmt.Sprintf("+ %s |", line.LineNumber)
		}
		return userStyle.Render(truncatePlain(fmt.Sprintf("%s %s", label, emptyFallback(line.Content, line.Text)), maxWidth))
	case "remove":
		label := "-"
		if strings.TrimSpace(line.LineNumber) != "" {
			label = fmt.Sprintf("- %s |", line.LineNumber)
		}
		return errorStyle.Render(truncatePlain(fmt.Sprintf("%s %s", label, emptyFallback(line.Content, line.Text)), maxWidth))
	case "kv":
		return dimStyle.Render(truncatePlain(line.Key+": ", maxWidth)) + asstStyle.Render(truncatePlain(line.Val, maxWidth))
	case "blank":
		return ""
	default:
		return truncatePlain(line.Text, maxWidth)
	}
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
		for _, wrapped := range wrapPlainText(line, maxInt(1, width)) {
			limited = append(limited, truncatePlain(wrapped, width))
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

func framedInnerWidth(style lipgloss.Style, outerWidth int) int {
	return maxInt(1, outerWidth-style.GetHorizontalFrameSize())
}

func framedInnerHeight(style lipgloss.Style, outerHeight int) int {
	return maxInt(1, outerHeight-style.GetVerticalFrameSize())
}

func messageStyles(message Message) (string, lipgloss.Style, lipgloss.Style) {
	switch message.Kind {
	case "tool_status":
		return "tool", reviewStyle.Bold(true), reviewStyle
	case "review_status":
		return "review", reviewStyle.Bold(true), reviewStyle
	case "system_hint":
		return "system", systemStyle.Bold(true), systemStyle
	case "error":
		return "error", errorStyle.Bold(true), errorStyle
	}

	switch message.Role {
	case "user":
		return "you", userStyle.Bold(true), lipgloss.NewStyle()
	case "assistant":
		return "cyrene", asstStyle.Bold(true), lipgloss.NewStyle()
	default:
		return "system", systemStyle.Bold(true), systemStyle
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
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("0")).Background(lipgloss.Color("11"))
	case StatusRequesting, StatusStreaming:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("0")).Background(lipgloss.Color("12"))
	case StatusAwaitingReview:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("0")).Background(lipgloss.Color("11"))
	case StatusError:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("15")).Background(lipgloss.Color("9"))
	default:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("0")).Background(lipgloss.Color("10"))
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

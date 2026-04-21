package app

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

func ParseRootArgForTest(args []string) string {
	return parseRootArg(args)
}

func ResolveRootPathForTest(cwd, raw string) (string, error) {
	return resolveRootPath(cwd, raw)
}

func SyncProcessAppRootForTest(appRoot string) error {
	return syncProcessAppRoot(appRoot)
}

func ListIndexAtPanelLineForTest(total, selected, pageSize, rowsPerItem, innerY, dataStartLine int) (int, bool) {
	return listIndexAtPanelLine(total, selected, pageSize, rowsPerItem, innerY, dataStartLine)
}

func (m *Model) RenderTranscriptForTest(width, height int) string {
	lines, _ := m.renderTranscriptWindow(width, height)
	return strings.Join(lines, "\n")
}

func (m *Model) RenderComposerForTest(width int) string {
	return m.renderComposer(width)
}

func (m *Model) TerminalCursorAnchorForTest() TerminalCursorAnchor {
	return m.TerminalCursorAnchor()
}

func (m *Model) SetComposerCompositionForTest(text string, cursor int) {
	m.setComposerComposition([]rune(text), cursor)
}

func (m *Model) CommitComposerCompositionForTest(text string) {
	m.commitComposerComposition([]rune(text))
}

func (m *Model) SetCurrentProviderFormatForTest(format string) {
	m.CurrentProviderFormat = format
}

func (m *Model) AttachmentsForTest() []Attachment {
	return cloneAttachments(m.Attachments)
}

func RenderMarkdownBodyLinesForTest(text string, width int, base lipgloss.Style) []string {
	return renderMarkdownBodyLines(text, width, base)
}

func StartupLogoColorForTest(row, col, rowCount, colCount int) lipgloss.CompleteColor {
	return startupLogoColorAt(row, col, rowCount, colCount)
}

func RenderStartupLogoLineForTest(text string, row, rowCount, colCount int) string {
	return renderGradientLogoLine(text, row, rowCount, colCount)
}

func SuggestSlashCommandsForTest(input string, limit int) []string {
	matches := suggestSlashCommands(input, limit)
	result := make([]string, 0, len(matches))
	for _, match := range matches {
		result = append(result, match.Command)
	}
	return result
}

func ApplySlashCompletionForTest(input string) (string, bool) {
	return applySlashCompletion(input)
}

func (m *Model) ApplyBridgeEventJSONForTest(payload string) error {
	var event bridgeEvent
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		return err
	}
	m.handleBridgeEvent(event)
	return nil
}

func (m *Model) TranscriptMessageCacheCountForTest() int {
	return len(m.transcriptMessageCache)
}

func (m *Model) TranscriptMessageCacheWidthForTest(index int) int {
	if index < 0 || index >= len(m.transcriptMessageCache) {
		return 0
	}
	return m.transcriptMessageCache[index].width
}

func SetClipboardReaderForTest(reader func() (string, error)) func() {
	previous := readClipboardText
	if reader == nil {
		readClipboardText = defaultClipboardTextReader
	} else {
		readClipboardText = reader
	}
	return func() {
		readClipboardText = previous
	}
}

func SetClipboardImageReaderForTest(reader func() (*ClipboardImage, error)) func() {
	previous := readClipboardImage
	if reader == nil {
		readClipboardImage = defaultClipboardImageReader
	} else {
		readClipboardImage = reader
	}
	return func() {
		readClipboardImage = previous
	}
}

func SetTimeNowForTest(reader func() time.Time) func() {
	previous := currentTime
	if reader == nil {
		currentTime = time.Now
	} else {
		currentTime = reader
	}
	return func() {
		currentTime = previous
	}
}

func (m *Model) ObserveTimeForTest(now time.Time) {
	m.observeStatusClock(now)
}

func (m *Model) RenderBottomStatusBarForTest(width int) string {
	return m.renderBottomStatusBar(width)
}

func StabilizeStatusClockForTest(expected, observed time.Time) time.Time {
	return stabilizeStatusClock(expected, observed)
}

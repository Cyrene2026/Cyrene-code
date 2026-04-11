package app

import (
	"encoding/json"

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

func ListIndexAtPanelLineForTest(total, selected, pageSize, innerY, dataStartLine int) (int, bool) {
	return listIndexAtPanelLine(total, selected, pageSize, innerY, dataStartLine)
}

func (m *Model) RenderTranscriptForTest(width, height int) string {
	return m.renderTranscript(width, height)
}

func RenderMarkdownBodyLinesForTest(text string, width int, base lipgloss.Style) []string {
	return renderMarkdownBodyLines(text, width, base)
}

func (m *Model) ApplyBridgeEventJSONForTest(payload string) error {
	var event bridgeEvent
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		return err
	}
	m.handleBridgeEvent(event)
	return nil
}

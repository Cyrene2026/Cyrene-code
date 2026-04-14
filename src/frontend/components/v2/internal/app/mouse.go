package app

import "github.com/charmbracelet/lipgloss"

type mouseRegion string

const (
	mouseRegionNone            mouseRegion = "none"
	mouseRegionHeader          mouseRegion = "header"
	mouseRegionTranscript      mouseRegion = "transcript"
	mouseRegionPanelOther      mouseRegion = "panel_other"
	mouseRegionApprovalQueue   mouseRegion = "approval_queue"
	mouseRegionApprovalPreview mouseRegion = "approval_preview"
	mouseRegionPlanList        mouseRegion = "plan_list"
	mouseRegionSessionList     mouseRegion = "session_list"
	mouseRegionModelList       mouseRegion = "model_list"
	mouseRegionProviderList    mouseRegion = "provider_list"
	mouseRegionComposer        mouseRegion = "composer"
	mouseRegionFooter          mouseRegion = "footer"
)

type mouseRect struct {
	Left   int
	Top    int
	Width  int
	Height int
}

func (r mouseRect) contains(x, y int) bool {
	return r.Width > 0 &&
		r.Height > 0 &&
		x >= r.Left &&
		x < r.Left+r.Width &&
		y >= r.Top &&
		y < r.Top+r.Height
}

func (r mouseRect) inset(dx, dy int) mouseRect {
	return mouseRect{
		Left:   r.Left + dx,
		Top:    r.Top + dy,
		Width:  maxInt(0, r.Width-(dx*2)),
		Height: maxInt(0, r.Height-(dy*2)),
	}
}

func (r mouseRect) pointAtLine(line int) (int, int, bool) {
	if r.Width <= 0 || r.Height <= 0 {
		return 0, 0, false
	}
	clampedLine := clampInt(line, 0, maxInt(0, r.Height-1))
	x := r.Left + clampInt(r.Width/2, 0, maxInt(0, r.Width-1))
	y := r.Top + clampedLine
	return x, y, true
}

type mouseLayout struct {
	Header   mouseRect
	Session  mouseRect
	Panel    mouseRect
	Composer mouseRect
	Footer   mouseRect
	HasPanel bool
}

type mouseHit struct {
	Region mouseRegion
	Index  int
}

func (m *Model) mouseLayout() mouseLayout {
	width := maxInt(50, m.Width)
	height := maxInt(18, m.Height)
	contentWidth := maxInt(30, framedInnerWidth(appShellStyle, width))
	contentHeight := maxInt(12, framedInnerHeight(appShellStyle, height))

	header := m.renderTopStatusBar(contentWidth)
	composer := m.renderComposer(contentWidth)
	footer := m.renderBottomStatusBar(contentWidth)
	headerHeight := lipgloss.Height(header)
	composerHeight := lipgloss.Height(composer)
	footerHeight := lipgloss.Height(footer)

	fixedHeight := headerHeight + composerHeight + footerHeight + 2
	bodyHeight := maxInt(5, contentHeight-fixedHeight)
	// After the outer border, header/body/composer/footer are joined directly
	// with '\n', so each section starts on the next row with no extra spacer.
	bodyTop := 1 + headerHeight

	layout := mouseLayout{
		Header: mouseRect{
			Left:   1,
			Top:    1,
			Width:  contentWidth,
			Height: maxInt(1, headerHeight),
		},
		Session: mouseRect{
			Left:   1,
			Top:    bodyTop,
			Width:  contentWidth,
			Height: bodyHeight,
		},
		Composer: mouseRect{
			Left:   1,
			Top:    bodyTop + bodyHeight,
			Width:  contentWidth,
			Height: maxInt(1, composerHeight),
		},
		Footer: mouseRect{
			Left:   1,
			Top:    bodyTop + bodyHeight + composerHeight,
			Width:  contentWidth,
			Height: maxInt(1, footerHeight),
		},
		HasPanel: m.ActivePanel != PanelNone,
	}

	if !layout.HasPanel {
		return layout
	}

	if contentWidth >= 96 {
		panelWidth := m.widePanelWidth(contentWidth)
		sessionWidth := maxInt(24, contentWidth-panelWidth-1)
		layout.Session.Width = sessionWidth
		layout.Panel = mouseRect{
			Left:   1 + sessionWidth + 1,
			Top:    bodyTop,
			Width:  panelWidth,
			Height: bodyHeight,
		}
		return layout
	}

	panelHeight := clampInt(bodyHeight/2, 10, 16)
	sessionHeight := maxInt(4, bodyHeight-panelHeight-1)
	layout.Session.Height = sessionHeight
	layout.Panel = mouseRect{
		Left:   1,
		Top:    bodyTop + sessionHeight,
		Width:  contentWidth,
		Height: panelHeight,
	}
	return layout
}

func (m *Model) mouseHitAt(mouseX, mouseY int) mouseHit {
	layout := m.mouseLayout()
	switch {
	case layout.Session.contains(mouseX, mouseY):
		return mouseHit{Region: mouseRegionTranscript}
	case layout.HasPanel && layout.Panel.contains(mouseX, mouseY):
		return m.panelMouseHit(layout.Panel, mouseX, mouseY)
	case layout.Composer.contains(mouseX, mouseY):
		return mouseHit{Region: mouseRegionComposer}
	case layout.Header.contains(mouseX, mouseY):
		return mouseHit{Region: mouseRegionHeader}
	case layout.Footer.contains(mouseX, mouseY):
		return mouseHit{Region: mouseRegionFooter}
	default:
		return mouseHit{Region: mouseRegionNone}
	}
}

func (m *Model) panelMouseHit(panelRect mouseRect, mouseX, mouseY int) mouseHit {
	inner := panelRect.inset(1, 1)
	if !inner.contains(mouseX, mouseY) {
		return mouseHit{Region: mouseRegionPanelOther}
	}

	innerY := mouseY - inner.Top
	bodyWidth := framedInnerWidth(panelBoxStyle, panelRect.Width)
	bodyHeight := framedInnerHeight(panelBoxStyle, panelRect.Height)

	switch m.ActivePanel {
	case PanelApprovals:
		page := pageForSelection(len(m.PendingReviews), m.ApprovalIndex, approvalQueuePageSize)
		queueLines := page.End - page.Start
		if index, ok := listIndexAtPanelLine(len(m.PendingReviews), m.ApprovalIndex, approvalQueuePageSize, 1, innerY, 2); ok {
			return mouseHit{Region: mouseRegionApprovalQueue, Index: index}
		}
		previewStart := 7 + queueLines
		if innerY >= previewStart && innerY < maxInt(0, bodyHeight-1) {
			return mouseHit{Region: mouseRegionApprovalPreview}
		}
	case PanelPlans:
		if index, ok := listIndexAtPanelLine(len(m.ExecutionPlan.Steps), m.PlanIndex, m.planPanelPageSizeForDimensions(panelRect.Width, panelRect.Height), 2, innerY, 2+planPanelOverviewRows(bodyWidth, m.ExecutionPlan)); ok {
			return mouseHit{Region: mouseRegionPlanList, Index: index}
		}
	case PanelSessions:
		if index, ok := listIndexAtPanelLine(len(m.Sessions), m.SessionIndex, m.sessionPanelPageSizeForDimensions(panelRect.Width, panelRect.Height), 2, innerY, 2); ok {
			return mouseHit{Region: mouseRegionSessionList, Index: index}
		}
	case PanelModels:
		if index, ok := listIndexAtPanelLine(len(m.AvailableModels), m.ModelIndex, m.modelPanelPageSizeForDimensions(panelRect.Width, panelRect.Height), 2, innerY, 2); ok {
			return mouseHit{Region: mouseRegionModelList, Index: index}
		}
	case PanelProviders:
		startLine := 2 + providerPanelCommandRows(bodyWidth)
		if index, ok := listIndexAtPanelLine(len(m.AvailableProviders), m.ProviderIndex, m.providerPanelPageSizeForDimensions(panelRect.Width, panelRect.Height), 3, innerY, startLine); ok {
			return mouseHit{Region: mouseRegionProviderList, Index: index}
		}
	}

	return mouseHit{Region: mouseRegionPanelOther}
}

package app

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

type mouseRegion string

const (
	mouseRegionNone                     mouseRegion = "none"
	mouseRegionHeader                   mouseRegion = "header"
	mouseRegionTranscript               mouseRegion = "transcript"
	mouseRegionTranscriptScrollbar      mouseRegion = "transcript_scrollbar"
	mouseRegionPanelOther               mouseRegion = "panel_other"
	mouseRegionApprovalQueue            mouseRegion = "approval_queue"
	mouseRegionApprovalPreview          mouseRegion = "approval_preview"
	mouseRegionApprovalPreviewScrollbar mouseRegion = "approval_preview_scrollbar"
	mouseRegionPlanList                 mouseRegion = "plan_list"
	mouseRegionPlanListScrollbar        mouseRegion = "plan_list_scrollbar"
	mouseRegionSessionList              mouseRegion = "session_list"
	mouseRegionSessionListScrollbar     mouseRegion = "session_list_scrollbar"
	mouseRegionModelList                mouseRegion = "model_list"
	mouseRegionModelListScrollbar       mouseRegion = "model_list_scrollbar"
	mouseRegionProviderList             mouseRegion = "provider_list"
	mouseRegionProviderListScrollbar    mouseRegion = "provider_list_scrollbar"
	mouseRegionComposer                 mouseRegion = "composer"
	mouseRegionFooter                   mouseRegion = "footer"
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

func insetRectForStyle(r mouseRect, style lipgloss.Style) mouseRect {
	left := style.GetPaddingLeft() + style.GetBorderLeftSize()
	right := style.GetPaddingRight() + style.GetBorderRightSize()
	top := style.GetPaddingTop() + style.GetBorderTopSize()
	bottom := style.GetPaddingBottom() + style.GetBorderBottomSize()
	return mouseRect{
		Left:   r.Left + left,
		Top:    r.Top + top,
		Width:  maxInt(0, r.Width-left-right),
		Height: maxInt(0, r.Height-top-bottom),
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

type scrollbarGeometry struct {
	Region      mouseRegion
	Rect        mouseRect
	Scroll      panelScrollState
	TrackHeight int
	ThumbStart  int
	ThumbSize   int
}

func (g scrollbarGeometry) contains(x, y int) bool {
	return g.Rect.contains(x, y)
}

func (g scrollbarGeometry) trackLineAt(y int) int {
	maxLine := maxInt(0, g.TrackHeight-1)
	return clampInt(y-g.Rect.Top, 0, maxLine)
}

func (g scrollbarGeometry) thumbLine() int {
	if g.ThumbSize <= 0 {
		return 0
	}
	return clampInt(g.ThumbStart+g.ThumbSize/2, 0, maxInt(0, g.Rect.Height-1))
}

func scrollbarGeometryForBlock(region mouseRegion, left, top, fullRows, visibleRows int, scroll panelScrollState) (scrollbarGeometry, bool) {
	if fullRows <= 1 || visibleRows <= 0 {
		return scrollbarGeometry{}, false
	}

	clickableRows := visibleRows
	if visibleRows >= fullRows {
		clickableRows = maxInt(0, fullRows-1)
	}
	if clickableRows <= 0 {
		return scrollbarGeometry{}, false
	}

	trackHeight := maxInt(0, fullRows-2)
	thumbStart, thumbSize := scrollbarThumb(scroll, trackHeight)
	return scrollbarGeometry{
		Region: region,
		Rect: mouseRect{
			Left:   left,
			Top:    top,
			Width:  1,
			Height: clickableRows,
		},
		Scroll:      scroll,
		TrackHeight: trackHeight,
		ThumbStart:  thumbStart,
		ThumbSize:   thumbSize,
	}, true
}

func (m *Model) mouseLayout() mouseLayout {
	width := maxInt(50, m.Width)
	height := maxInt(18, m.Height)
	contentWidth := maxInt(30, framedInnerWidth(appShellStyle, width))
	contentHeight := maxInt(12, framedInnerHeight(appShellStyle, height))

	header := m.renderTopStatusBar(contentWidth)
	composer := m.renderComposer(contentWidth)
	topComposerDivider := renderComposerDivider(contentWidth)
	bottomComposerDivider := renderComposerDivider(contentWidth)
	footer := m.renderBottomStatusBar(contentWidth)
	headerHeight := lipgloss.Height(header)
	composerHeight := lipgloss.Height(composer)
	topDividerHeight := lipgloss.Height(topComposerDivider)
	bottomDividerHeight := lipgloss.Height(bottomComposerDivider)
	footerHeight := lipgloss.Height(footer)

	fixedHeight := headerHeight + composerHeight + topDividerHeight + bottomDividerHeight + footerHeight
	bodyHeight := maxInt(5, contentHeight-fixedHeight)
	bodyTop := headerHeight

	layout := mouseLayout{
		Header: mouseRect{
			Left:   0,
			Top:    0,
			Width:  contentWidth,
			Height: maxInt(1, headerHeight),
		},
		Session: mouseRect{
			Left:   0,
			Top:    bodyTop,
			Width:  contentWidth,
			Height: bodyHeight,
		},
		Footer: mouseRect{
			Left:   0,
			Top:    bodyTop + bodyHeight + topDividerHeight + composerHeight + bottomDividerHeight,
			Width:  contentWidth,
			Height: maxInt(1, footerHeight),
		},
		Composer: mouseRect{
			Left:   0,
			Top:    bodyTop + bodyHeight + topDividerHeight,
			Width:  contentWidth,
			Height: maxInt(1, composerHeight),
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
			Left:   sessionWidth + 1,
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
		Left:   0,
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
		if geometry, ok := m.transcriptScrollbarGeometry(layout); ok && geometry.contains(mouseX, mouseY) {
			return mouseHit{Region: geometry.Region, Index: -1}
		}
		return mouseHit{Region: mouseRegionTranscript}
	case layout.HasPanel && layout.Panel.contains(mouseX, mouseY):
		if geometry, ok := m.panelScrollbarGeometry(layout.Panel); ok && geometry.contains(mouseX, mouseY) {
			return mouseHit{Region: geometry.Region, Index: -1}
		}
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

func (m *Model) scrollbarGeometryByRegion(region mouseRegion) (scrollbarGeometry, bool) {
	layout := m.mouseLayout()
	switch region {
	case mouseRegionTranscriptScrollbar:
		return m.transcriptScrollbarGeometry(layout)
	case mouseRegionApprovalPreviewScrollbar,
		mouseRegionPlanListScrollbar,
		mouseRegionSessionListScrollbar,
		mouseRegionModelListScrollbar,
		mouseRegionProviderListScrollbar:
		if !layout.HasPanel {
			return scrollbarGeometry{}, false
		}
		geometry, ok := m.panelScrollbarGeometry(layout.Panel)
		if !ok || geometry.Region != region {
			return scrollbarGeometry{}, false
		}
		return geometry, true
	default:
		return scrollbarGeometry{}, false
	}
}

func (m *Model) transcriptScrollbarGeometry(layout mouseLayout) (scrollbarGeometry, bool) {
	style := frameStyle
	if m.ActivePanel == PanelNone {
		style = activeFrameStyle
	}
	inner := insetRectForStyle(layout.Session, style)
	if inner.Width <= 0 || inner.Height <= 0 {
		return scrollbarGeometry{}, false
	}

	contentWidth := maxInt(1, inner.Width-2)
	lines, scroll := m.renderTranscriptWindow(contentWidth, maxInt(1, inner.Height))
	return scrollbarGeometryForBlock(
		mouseRegionTranscriptScrollbar,
		inner.Left+inner.Width-1,
		inner.Top,
		len(lines),
		len(lines),
		scroll,
	)
}

func (m *Model) panelScrollbarGeometry(panelRect mouseRect) (scrollbarGeometry, bool) {
	inner := insetRectForStyle(panelRect, panelBoxStyle)
	if inner.Width <= 0 || inner.Height <= 0 {
		return scrollbarGeometry{}, false
	}

	bodyWidth := framedInnerWidth(panelBoxStyle, panelRect.Width)
	bodyHeight := framedInnerHeight(panelBoxStyle, panelRect.Height)
	x := inner.Left + inner.Width - 1

	switch m.ActivePanel {
	case PanelApprovals:
		if len(m.PendingReviews) == 0 {
			return scrollbarGeometry{}, false
		}
		page := pageForSelection(len(m.PendingReviews), m.ApprovalIndex, approvalQueuePageSize)
		queueLines := page.End - page.Start
		selected := m.PendingReviews[clampInt(m.ApprovalIndex, 0, len(m.PendingReviews)-1)]
		previewSource := selected.PreviewSummary
		if m.ApprovalPreview == ApprovalFull && strings.TrimSpace(selected.PreviewFull) != "" {
			previewSource = selected.PreviewFull
		}
		previewLines := parseApprovalPreviewLines(previewSource)
		window := previewWindow(previewLines, m.ApprovalPreviewOffset, approvalPreviewPageLines)
		renderedRows := 0
		for _, line := range window.Lines {
			renderedRows += len(renderApprovalPreviewLines(line, bodyWidth))
		}
		startLine := 7 + queueLines
		visibleRows := minInt(renderedRows, maxInt(0, bodyHeight-1-startLine))
		return scrollbarGeometryForBlock(
			mouseRegionApprovalPreviewScrollbar,
			x,
			inner.Top+startLine,
			renderedRows,
			visibleRows,
			panelScrollState{
				Offset:  window.Start,
				Visible: minInt(window.Total, approvalPreviewPageLines),
				Total:   window.Total,
			},
		)
	case PanelPlans:
		if len(m.ExecutionPlan.Steps) == 0 {
			return scrollbarGeometry{}, false
		}
		page := pageForSelection(len(m.ExecutionPlan.Steps), m.PlanIndex, m.planPanelPageSizeForDimensions(panelRect.Width, panelRect.Height))
		listRows := maxInt(1, (page.End-page.Start)*2)
		startLine := 3 + planPanelOverviewRows(bodyWidth, m.ExecutionPlan) + planPanelAcceptedRows(bodyWidth, m.ExecutionPlan)
		visibleRows := minInt(listRows, maxInt(0, bodyHeight-1-startLine))
		return scrollbarGeometryForBlock(
			mouseRegionPlanListScrollbar,
			x,
			inner.Top+startLine,
			listRows,
			visibleRows,
			panelScrollState{
				Offset:  maxInt(0, page.CurrentPage-1),
				Visible: 1,
				Total:   maxInt(1, page.TotalPages),
			},
		)
	case PanelSessions:
		if len(m.Sessions) == 0 {
			return scrollbarGeometry{}, false
		}
		page := pageForSelection(len(m.Sessions), m.SessionIndex, m.sessionPanelPageSizeForDimensions(panelRect.Width, panelRect.Height))
		listRows := maxInt(1, (page.End-page.Start)*2)
		return scrollbarGeometryForBlock(
			mouseRegionSessionListScrollbar,
			x,
			inner.Top+2,
			listRows,
			listRows,
			panelScrollState{
				Offset:  maxInt(0, page.CurrentPage-1),
				Visible: 1,
				Total:   maxInt(1, page.TotalPages),
			},
		)
	case PanelModels:
		if len(m.AvailableModels) == 0 {
			return scrollbarGeometry{}, false
		}
		page := pageForSelection(len(m.AvailableModels), m.ModelIndex, m.modelPanelPageSizeForDimensions(panelRect.Width, panelRect.Height))
		listRows := maxInt(1, (page.End-page.Start)*2)
		startLine := 2 + len(wrapPlainText("custom model id: press c to prefill /model custom <id> in the composer", bodyWidth))
		visibleRows := minInt(listRows, maxInt(0, bodyHeight-1-startLine))
		return scrollbarGeometryForBlock(
			mouseRegionModelListScrollbar,
			x,
			inner.Top+startLine,
			listRows,
			visibleRows,
			panelScrollState{
				Offset:  maxInt(0, page.CurrentPage-1),
				Visible: 1,
				Total:   maxInt(1, page.TotalPages),
			},
		)
	case PanelProviders:
		if len(m.AvailableProviders) == 0 {
			return scrollbarGeometry{}, false
		}
		page := pageForSelection(len(m.AvailableProviders), m.ProviderIndex, m.providerPanelPageSizeForDimensions(panelRect.Width, panelRect.Height))
		listRows := maxInt(1, (page.End-page.Start)*3)
		startLine := 2 + providerPanelCommandRows(bodyWidth)
		visibleRows := minInt(listRows, maxInt(0, bodyHeight-1-startLine))
		return scrollbarGeometryForBlock(
			mouseRegionProviderListScrollbar,
			x,
			inner.Top+startLine,
			listRows,
			visibleRows,
			panelScrollState{
				Offset:  maxInt(0, page.CurrentPage-1),
				Visible: 1,
				Total:   maxInt(1, page.TotalPages),
			},
		)
	default:
		return scrollbarGeometry{}, false
	}
}

func (m *Model) panelMouseHit(panelRect mouseRect, mouseX, mouseY int) mouseHit {
	inner := insetRectForStyle(panelRect, panelBoxStyle)
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

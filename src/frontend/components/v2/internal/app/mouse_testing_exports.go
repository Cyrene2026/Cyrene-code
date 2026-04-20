package app

func (m *Model) TranscriptMousePointForTest() (int, int, bool) {
	layout := m.mouseLayout()
	inner := insetRectForStyle(layout.Session, frameStyle)
	return inner.pointAtLine(maxInt(0, inner.Height/2))
}

func (m *Model) PanelItemMousePointForTest(index, rowOffset int) (int, int, bool) {
	layout := m.mouseLayout()
	if !layout.HasPanel {
		return 0, 0, false
	}

	inner := insetRectForStyle(layout.Panel, panelBoxStyle)
	if inner.Width <= 0 || inner.Height <= 0 {
		return 0, 0, false
	}

	line, ok := m.panelItemLineForTest(layout.Panel, index, rowOffset)
	if !ok {
		return 0, 0, false
	}
	return inner.pointAtLine(line)
}

func (m *Model) ApprovalPreviewMousePointForTest() (int, int, bool) {
	layout := m.mouseLayout()
	if !layout.HasPanel || m.ActivePanel != PanelApprovals {
		return 0, 0, false
	}

	inner := insetRectForStyle(layout.Panel, panelBoxStyle)
	if inner.Width <= 0 || inner.Height <= 0 {
		return 0, 0, false
	}

	page := pageForSelection(len(m.PendingReviews), m.ApprovalIndex, approvalQueuePageSize)
	previewStart := 7 + (page.End - page.Start)
	return inner.pointAtLine(previewStart)
}

func (m *Model) TranscriptScrollbarThumbMousePointForTest() (int, int, bool) {
	return m.scrollbarThumbMousePointForTest(mouseRegionTranscriptScrollbar)
}

func (m *Model) TranscriptScrollbarTrackMousePointForTest(line int) (int, int, bool) {
	return m.scrollbarTrackMousePointForTest(mouseRegionTranscriptScrollbar, line)
}

func (m *Model) PanelScrollbarThumbMousePointForTest() (int, int, bool) {
	return m.scrollbarThumbMousePointForTest(m.activePanelScrollbarRegionForTest())
}

func (m *Model) PanelScrollbarTrackMousePointForTest(line int) (int, int, bool) {
	return m.scrollbarTrackMousePointForTest(m.activePanelScrollbarRegionForTest(), line)
}

func (m *Model) ComposerMousePointForTest() (int, int, bool) {
	layout := m.mouseLayout()
	return layout.Composer.pointAtLine(maxInt(0, layout.Composer.Height/2))
}

func (m *Model) ComposerAttachmentAddMousePointForTest() (int, int, bool) {
	layout := m.mouseLayout()
	style := focusedInputBoxStyle
	if m.ActivePanel != PanelNone {
		style = inputBoxStyle
	}
	inner := insetRectForStyle(layout.Composer, style)
	line := m.composerAttachmentBarLine(inner.Width)
	for _, segment := range line.Segments {
		if segment.Kind != "add" {
			continue
		}
		x := inner.Left + segment.Start + maxInt(0, (segment.End-segment.Start)/2)
		y := inner.Top + noticeAndSlashPrefixLinesForComposer(m, inner.Width)
		return x, y, true
	}
	return 0, 0, false
}

func (m *Model) ComposerAttachmentRemoveMousePointForTest(index int) (int, int, bool) {
	layout := m.mouseLayout()
	style := focusedInputBoxStyle
	if m.ActivePanel != PanelNone {
		style = inputBoxStyle
	}
	inner := insetRectForStyle(layout.Composer, style)
	line := m.composerAttachmentBarLine(inner.Width)
	for _, segment := range line.Segments {
		if segment.Kind != "attachment" || segment.Index != index {
			continue
		}
		x := inner.Left + segment.Start + maxInt(0, (segment.End-segment.Start)/2)
		y := inner.Top + noticeAndSlashPrefixLinesForComposer(m, inner.Width)
		return x, y, true
	}
	return 0, 0, false
}

func (m *Model) scrollbarThumbMousePointForTest(region mouseRegion) (int, int, bool) {
	geometry, ok := m.scrollbarGeometryByRegion(region)
	if !ok {
		return 0, 0, false
	}
	return geometry.Rect.pointAtLine(geometry.thumbLine())
}

func (m *Model) scrollbarTrackMousePointForTest(region mouseRegion, line int) (int, int, bool) {
	geometry, ok := m.scrollbarGeometryByRegion(region)
	if !ok {
		return 0, 0, false
	}
	return geometry.Rect.pointAtLine(line)
}

func (m *Model) activePanelScrollbarRegionForTest() mouseRegion {
	switch m.ActivePanel {
	case PanelApprovals:
		return mouseRegionApprovalPreviewScrollbar
	case PanelPlans:
		return mouseRegionPlanListScrollbar
	case PanelSessions:
		return mouseRegionSessionListScrollbar
	case PanelModels:
		return mouseRegionModelListScrollbar
	case PanelProviders:
		return mouseRegionProviderListScrollbar
	default:
		return mouseRegionNone
	}
}

func (m *Model) panelItemLineForTest(panelRect mouseRect, index, rowOffset int) (int, bool) {
	bodyWidth := framedInnerWidth(panelBoxStyle, panelRect.Width)
	switch m.ActivePanel {
	case PanelApprovals:
		page := pageForSelection(len(m.PendingReviews), m.ApprovalIndex, approvalQueuePageSize)
		if index < page.Start || index >= page.End {
			return 0, false
		}
		return 2 + (index - page.Start) + clampInt(rowOffset, 0, 0), true
	case PanelPlans:
		page := pageForSelection(len(m.ExecutionPlan.Steps), m.PlanIndex, m.planPanelPageSizeForDimensions(panelRect.Width, panelRect.Height))
		if index < page.Start || index >= page.End {
			return 0, false
		}
		return 2 + planPanelOverviewRows(bodyWidth, m.ExecutionPlan) + ((index - page.Start) * 2) + clampInt(rowOffset, 0, 1), true
	case PanelSessions:
		page := pageForSelection(len(m.Sessions), m.SessionIndex, m.sessionPanelPageSizeForDimensions(panelRect.Width, panelRect.Height))
		if index < page.Start || index >= page.End {
			return 0, false
		}
		return 2 + ((index - page.Start) * 2) + clampInt(rowOffset, 0, 1), true
	case PanelModels:
		page := pageForSelection(len(m.AvailableModels), m.ModelIndex, m.modelPanelPageSizeForDimensions(panelRect.Width, panelRect.Height))
		if index < page.Start || index >= page.End {
			return 0, false
		}
		return 2 + ((index - page.Start) * 2) + clampInt(rowOffset, 0, 1), true
	case PanelProviders:
		page := pageForSelection(len(m.AvailableProviders), m.ProviderIndex, m.providerPanelPageSizeForDimensions(panelRect.Width, panelRect.Height))
		if index < page.Start || index >= page.End {
			return 0, false
		}
		return 2 + providerPanelCommandRows(bodyWidth) + ((index - page.Start) * 3) + clampInt(rowOffset, 0, 2), true
	default:
		return 0, false
	}
}

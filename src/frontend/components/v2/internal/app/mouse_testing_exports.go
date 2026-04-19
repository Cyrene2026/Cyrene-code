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

func (m *Model) ComposerMousePointForTest() (int, int, bool) {
	layout := m.mouseLayout()
	return layout.Composer.pointAtLine(maxInt(0, layout.Composer.Height/2))
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

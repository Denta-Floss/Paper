import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../data/mock_production_pipelines_data.dart';
import '../state/production_pipelines_controller.dart';
import '../widgets/pp_aging_table.dart';
import '../widgets/pp_filter_toolbar.dart';
import '../widgets/pp_sidebar.dart';
import '../widgets/pp_summary_cards_row.dart';
import '../widgets/pp_top_bar.dart';

class ProductionPipelinesScreen extends StatelessWidget {
  const ProductionPipelinesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => ProductionPipelinesController(),
      child: const _ProductionPipelinesView(),
    );
  }
}

class _ProductionPipelinesView extends StatelessWidget {
  const _ProductionPipelinesView();

  static const double _figmaCanvasWidth = 1920;
  static const double _figmaCanvasHeight = 1080;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final height = constraints.maxHeight;
        final isDesktop = width >= 1200;
        final isTablet = width >= 800 && width < 1200;
        final isMobile = width < 800;
        final useDesignCanvas = width >= 1600 && height >= 900;
        final compactContent = width < 1200;

        final sidebarWidth = isDesktop
            ? 225.0
            : isTablet
                ? 88.0
                : 0.0;

        return Scaffold(
          backgroundColor: const Color(0xFFF1F1F1),
          drawer: isMobile
              ? Drawer(
                  width: 230,
                  child: Consumer<ProductionPipelinesController>(
                    builder: (context, controller, _) => PPSidebar(
                      selectedKey: controller.state.selectedSidebarKey,
                      compact: false,
                      onTap: (key) {
                        controller.setSidebar(key);
                        Navigator.of(context).pop();
                      },
                    ),
                  ),
                )
              : null,
          appBar: isMobile
              ? AppBar(
                  backgroundColor: const Color(0xFF6049E3),
                  title: const Text('Production Pipelines'),
                )
              : null,
          body: Stack(
            children: [
              if (isMobile)
                const Positioned.fill(child: ColoredBox(color: Color(0xFFF1F1F1)))
              else
                Positioned.fill(
                  child: Row(
                    children: [
                      SizedBox(
                        width: sidebarWidth,
                        child: const ColoredBox(color: Color(0xFF13161F)),
                      ),
                      const Expanded(child: ColoredBox(color: Color(0xFFF1F1F1))),
                    ],
                  ),
                ),
              SafeArea(
                child: useDesignCanvas
                    ? Center(
                        child: FittedBox(
                          fit: BoxFit.contain,
                          alignment: Alignment.topCenter,
                          child: SizedBox(
                            width: _figmaCanvasWidth,
                            height: _figmaCanvasHeight,
                            child: _buildMainLayout(
                              isMobile: false,
                              isTablet: false,
                              compactContent: false,
                              sidebarWidth: 225,
                            ),
                          ),
                        ),
                      )
                    : _buildMainLayout(
                        isMobile: isMobile,
                        isTablet: isTablet,
                        compactContent: compactContent,
                        sidebarWidth: sidebarWidth,
                      ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildMainLayout({
    required bool isMobile,
    required bool isTablet,
    required bool compactContent,
    required double sidebarWidth,
  }) {
    return Row(
      children: [
        if (!isMobile)
          SizedBox(
            width: sidebarWidth,
            child: Consumer<ProductionPipelinesController>(
              builder: (context, controller, _) => PPSidebar(
                selectedKey: controller.state.selectedSidebarKey,
                compact: isTablet,
                onTap: controller.setSidebar,
              ),
            ),
          ),
        Expanded(
          child: Column(
            children: [
              PPTopBar(compact: compactContent),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(24, 16, 24, 16),
                  child: Consumer<ProductionPipelinesController>(
                    builder: (context, controller, _) {
                      final state = controller.state;

                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Heading',
                            style: TextStyle(
                              fontSize: 20,
                              color: Color(0xFF3C3C3C),
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          const SizedBox(height: 12),
                          PPFilterToolbar(
                            selectedFilters: state.selectedFilters,
                            filterOptions: MockProductionPipelinesData.filterOptions,
                            selectedCount: controller.selectedCount,
                            onFilterChanged: controller.setFilter,
                            onSortPressed: () => controller.toggleSortBy('partyName'),
                            onClearSelection: controller.clearSelection,
                            isMobile: isMobile,
                            sortAscending: state.sortAscending,
                          ),
                          const SizedBox(height: 12),
                          PPSummaryCardsRow(
                            cards: controller.summaryCards,
                            compact: compactContent,
                            selectedCardId: state.selectedSummaryCardId,
                            onCardTap: controller.toggleSummaryCard,
                          ),
                          const SizedBox(height: 12),
                          Expanded(
                            child: PPAgingTable(
                              rows: controller.visibleRows,
                              onToggleRow: controller.toggleRowSelection,
                              minWidth: isMobile ? 980 : 1518,
                            ),
                          ),
                        ],
                      );
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

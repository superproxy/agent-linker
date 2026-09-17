import type { ThemeConfig } from 'antd';
import { theme as antdTheme } from 'antd';

/**
 * 深色专业运维风主题（Linear / Vercel 质感）。
 * 以 antd dark algorithm 为底，覆盖品牌色、圆角、字号与关键组件 token。
 */
export const themeConfig: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: '#3b82f6',
    colorInfo: '#3b82f6',
    colorSuccess: '#22c55e',
    colorWarning: '#eab308',
    colorError: '#ef4444',
    colorTextBase: '#e5e9f0',
    colorBgBase: '#0a0c10',
    borderRadius: 8,
    fontSize: 13.5,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', Roboto, sans-serif",
    wireframe: false,
  },
  components: {
    Layout: {
      headerBg: '#0d1017',
      siderBg: '#0d1017',
      bodyBg: '#0a0c10',
      headerHeight: 56,
      headerPadding: '0 20px',
    },
    Menu: {
      darkItemBg: 'transparent',
      darkSubMenuItemBg: 'transparent',
      darkItemSelectedBg: 'rgba(59,130,246,0.18)',
      darkItemHoverBg: 'rgba(255,255,255,0.05)',
      darkItemColor: 'rgba(229,233,240,0.62)',
      darkItemSelectedColor: '#f3f6fb',
      itemBorderRadius: 8,
      itemMarginInline: 8,
      itemHeight: 38,
      iconSize: 15,
    },
    Card: {
      colorBgContainer: '#11141b',
      colorBorderSecondary: '#1e2430',
      headerBg: 'transparent',
      paddingLG: 18,
    },
    Table: {
      colorBgContainer: 'transparent',
      headerBg: 'transparent',
      headerColor: 'rgba(229,233,240,0.45)',
      headerSplitColor: 'transparent',
      borderColor: '#1c222c',
      rowHoverBg: 'rgba(255,255,255,0.028)',
      cellPaddingBlock: 11,
    },
    Button: {
      controlHeight: 32,
      controlHeightSM: 26,
      fontWeight: 500,
    },
    Input: { controlHeight: 34 },
    InputNumber: { controlHeight: 34 },
    Select: { controlHeight: 34 },
    Modal: { contentBg: '#11141b', headerBg: '#11141b' },
    Statistic: { titleFontSize: 12.5, contentFontSize: 26 },
    Tooltip: { borderRadius: 6 },
    Tag: { borderRadiusSM: 6 },
  },
};

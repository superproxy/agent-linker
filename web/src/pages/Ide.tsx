import { Card, Typography } from 'antd';

const { Title, Text } = Typography;

interface IdePageProps {
  base: string;
  token: string;
  onAuthError: (e: unknown) => boolean;
  onGoTab?: (t: any) => void;
}

export function IdePage({}: IdePageProps) {
  return (
    <div style={{ padding: '16px' }}>
      <Card>
        <div style={{ textAlign: 'center', padding: '100px 0' }}>
          <Title level={3}>在线IDE</Title>
          <Text type="secondary">功能开发中，敬请期待...</Text>
        </div>
      </Card>
    </div>
  );
}

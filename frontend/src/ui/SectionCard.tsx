import type { ReactNode } from 'react';
import { Card, CardHeader, CardBody } from './Card';

export function SectionCard({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }): React.ReactElement {
  return (
    <Card>
      <CardHeader title={title} action={action} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

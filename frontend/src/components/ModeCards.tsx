import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';

const MODE_COPY = {
  baseline: { title: 'BASELINE', description: 'Deterministic, verbatim extraction. No LLM. Fast.' },
  survey: { title: 'SURVEY', description: 'LLM-driven distillation into formal "shall" requirements. 15-40+ min on real documents.' },
} as const;

export function ModeCards({
  value,
  onChange,
}: {
  value: 'baseline' | 'survey';
  onChange: (mode: 'baseline' | 'survey') => void;
}): React.ReactElement {
  return (
    <Stack direction="row" spacing={2}>
      {(Object.keys(MODE_COPY) as Array<'baseline' | 'survey'>).map((mode) => (
        <Card key={mode} variant={value === mode ? 'elevation' : 'outlined'}>
          <CardActionArea onClick={() => onChange(mode)}>
            <CardContent>
              <Typography variant="h6">{MODE_COPY[mode].title}</Typography>
              <Typography variant="body2">{MODE_COPY[mode].description}</Typography>
            </CardContent>
          </CardActionArea>
        </Card>
      ))}
    </Stack>
  );
}

import { Box, Slider, Typography } from "@mui/material";

export function ScaleField({ label, value, onChange, min = 0, max = 100, step = 1, lowLabel, highLabel }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; lowLabel?: string; highLabel?: string;
}) {
  return <Box sx={{ my: 3 }}>
    <Typography component="label" htmlFor={`scale-${label.replaceAll(" ", "-")}`} fontWeight={700}>{label}: {value}</Typography>
    <Slider id={`scale-${label.replaceAll(" ", "-")}`} aria-label={label} value={value} min={min} max={max} step={step}
      valueLabelDisplay="auto" onChange={(_event, next) => onChange(next as number)} sx={{ mt: 1 }} />
    <Box sx={{ display: "flex", justifyContent: "space-between", color: "text.secondary" }}>
      <Typography variant="caption">{lowLabel ?? min}</Typography><Typography variant="caption">{highLabel ?? max}</Typography>
    </Box>
  </Box>;
}

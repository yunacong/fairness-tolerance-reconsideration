import { Box, Card, CardContent, FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Typography } from "@mui/material";
import type { ViewMetadata } from "../types";

export function ViewCards({ views, value, onChange }: { views: ViewMetadata[]; value: string; onChange: (value: string) => void }) {
  return <FormControl fullWidth>
    <FormLabel id="fairness-view-label" sx={{ mb: 2, color: "text.primary", fontWeight: 700 }}>Choose one complete Fairness View</FormLabel>
    <RadioGroup aria-labelledby="fairness-view-label" name="fairness-view" value={value} onChange={(event) => onChange(event.target.value)}>
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { md: "repeat(3, 1fr)" } }}>
        {views.map((view) => <Card key={view.view_id} variant="outlined" sx={{ borderColor: value === view.view_id ? "primary.main" : "divider", borderWidth: 2 }}>
          <CardContent>
            <FormControlLabel value={view.view_id} control={<Radio />} label={<Box>
              <Typography variant="overline" color="primary.main">{view.view_id}</Typography>
              <Typography variant="h3" component="h3">{view.group_label}</Typography>
              <Typography fontWeight={700} sx={{ mt: 1 }}>{view.metric_label}</Typography>
              <Typography color="text.secondary" sx={{ mt: 1 }}>{view.description}</Typography>
              <Typography variant="body2" sx={{ mt: 2 }}>Groups: {view.group_a} and {view.group_b}</Typography>
            </Box>} sx={{ alignItems: "flex-start", m: 0 }} />
          </CardContent>
        </Card>)}
      </Box>
    </RadioGroup>
  </FormControl>;
}

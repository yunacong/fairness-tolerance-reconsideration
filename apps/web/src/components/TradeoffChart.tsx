import { Box, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import type { TradeoffView } from "../types";

export function TradeoffChart({ view }: { view: TradeoffView }) {
  const width = 720, height = 420, padding = 58;
  const x = (value: number) => padding + value / 100 * (width - padding * 2);
  const y = (value: number) => height - padding - value / 100 * (height - padding * 2);
  return <Box>
    <Typography variant="h3" component="h3" gutterBottom>{view.title}</Typography>
    <Typography color="text.secondary" sx={{ mb: 2 }}>Each point is a feasible model configuration. Lower disparity means a smaller observed group difference; accuracy is a simplified utility proxy.</Typography>
    <Paper variant="outlined" sx={{ p: 1, overflowX: "auto" }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="chart-title chart-desc" style={{ width: "100%", minWidth: 620 }}>
        <title id="chart-title">Fairness disparity and accuracy trade-off</title>
        <desc id="chart-desc">Scatter plot of feasible model configurations. Horizontal axis is fairness disparity in percent. Vertical axis is accuracy in percent.</desc>
        {[0, 25, 50, 75, 100].map((tick) => <g key={tick}>
          <line x1={x(tick)} x2={x(tick)} y1={padding} y2={height - padding} stroke="#DDE6E8" />
          <text x={x(tick)} y={height - padding + 24} textAnchor="middle" fontSize="13">{tick}</text>
          <line x1={padding} x2={width - padding} y1={y(tick)} y2={y(tick)} stroke="#DDE6E8" />
          <text x={padding - 16} y={y(tick) + 4} textAnchor="end" fontSize="13">{tick}</text>
        </g>)}
        <line x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} stroke="#17242A" strokeWidth="2" />
        <line x1={padding} x2={padding} y1={padding} y2={height - padding} stroke="#17242A" strokeWidth="2" />
        <text x={width / 2} y={height - 10} textAnchor="middle" fontWeight="700">Fairness disparity (%)</text>
        <text transform={`translate(18 ${height / 2}) rotate(-90)`} textAnchor="middle" fontWeight="700">Accuracy (%)</text>
        {view.points.map((point) => <circle key={point.model_config_id} cx={x(point.fairness_disparity_pp)} cy={y(point.accuracy_pp)} r="7" fill="#125E72" stroke="#fff" strokeWidth="2">
          <title>{`${point.model_config_id}: disparity ${point.fairness_disparity_pp}%, accuracy ${point.accuracy_pp}%`}</title>
        </circle>)}
      </svg>
    </Paper>
    <TableContainer component={Paper} variant="outlined" sx={{ mt: 2, maxHeight: 300 }}>
      <Table stickyHeader size="small" aria-label="Accessible model configuration data">
        <TableHead><TableRow><TableCell>Model configuration</TableCell><TableCell align="right">Fairness disparity (%)</TableCell><TableCell align="right">Accuracy (%)</TableCell></TableRow></TableHead>
        <TableBody>{view.points.map((point) => <TableRow key={point.model_config_id}><TableCell>{point.model_config_id}</TableCell><TableCell align="right">{point.fairness_disparity_pp.toFixed(2)}</TableCell><TableCell align="right">{point.accuracy_pp.toFixed(2)}</TableCell></TableRow>)}</TableBody>
      </Table>
    </TableContainer>
  </Box>;
}

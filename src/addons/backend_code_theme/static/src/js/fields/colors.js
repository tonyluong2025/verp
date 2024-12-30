/** @verp-module **/
import { COLORS } from "@web/views/graph/colors";

var codeBackendColor = ["#556ee6", "#f1b44c", "#50a5f1", "#ffbb78", "#34c38f", "#98df8a", "#d62728",
        "#ff9896", "#9467bd", "#c5b0d5", "#8c564b", "#c49c94", "#e377c2", "#f7b6d2",
        "#7f7f7f", "#c7c7c7", "#bcbd22", "#dbdb8d", "#17becf", "#9edae5"];

for (let i=0;i<=codeBackendColor.length;i++){
    COLORS[i] = codeBackendColor[i]
}

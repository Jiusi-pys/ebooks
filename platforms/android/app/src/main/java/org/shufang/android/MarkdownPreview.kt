package org.shufang.android

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/** Local formatted preview; the saved Markdown stays intact for Web editors. */
@Composable fun MarkdownPreview(source:String) {
    var show by remember {mutableStateOf(false)}
    TextButton(onClick={show=!show}){Text(if(show)"收起排版预览"else "排版预览")}
    if(!show)return
    val visible=remember(source){source.replace(Regex("<!--[\\s\\S]*?-->"),"")}
    Surface(tonalElevation=2.dp,modifier=Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
            visible.lineSequence().take(1000).forEach {line->
                val heading=line.takeWhile {it=='#'}.length
                val text=when {heading in 1..6->line.drop(heading).trimStart();line.startsWith("- [x] ")->"☑ "+line.drop(6);line.startsWith("- [ ] ")->"☐ "+line.drop(6);line.startsWith("- ")->"• "+line.drop(2);line.startsWith("> ")->"┃ "+line.drop(2);else->line}
                val formatted=buildAnnotatedString {
                    var at=0
                    Regex("\\*\\*([^*]+)\\*\\*|`([^`]+)`").findAll(text).forEach {match->
                        append(text.substring(at,match.range.first))
                        withStyle(if(match.groupValues[1].isNotEmpty())SpanStyle(fontWeight=FontWeight.Bold)else SpanStyle(fontFamily=FontFamily.Monospace)){append(match.groupValues[1].ifEmpty {match.groupValues[2]})}
                        at=match.range.last+1
                    };append(text.substring(at))
                }
                Text(formatted,style=when(heading){1->MaterialTheme.typography.headlineMedium;2->MaterialTheme.typography.titleLarge;3,4,5,6->MaterialTheme.typography.titleMedium;else->MaterialTheme.typography.bodyMedium})
            }
            if(visible.lineSequence().count()>1000)Text("预览显示前 1000 行，完整内容保留在编辑器中")
        }
    }
}

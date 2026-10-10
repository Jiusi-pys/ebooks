package org.shufang.android

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File

@Composable fun PdfSearchView(model:LibraryViewModel,state:LibraryState,query:String,bookIds:List<String>?) {
    val scope=rememberCoroutineScope();val ready=remember {CompletableDeferred<Unit>()}
    var document by remember {mutableStateOf<DocumentWebView?>(null)}
    var finished by remember {mutableStateOf<CompletableDeferred<Unit>?>(null)}
    var progress by remember {mutableStateOf("")}
    val token=state.searchToken
    val books=state.records["books"].orEmpty().filter {it.text("format")=="pdf"&&it.text("readerMode")=="original"&&(bookIds==null||it.id in bookIds)}
    if(books.isEmpty())return
    if(progress.isNotEmpty())androidx.compose.material3.Text(progress)
    Box(Modifier.size(1.dp)) {AndroidView(factory={context->DocumentWebView(context,scope){event->
        when(event.optString("type")) {
            "ready"->ready.complete(Unit)
            "pdfSearchProgress"->if(event.optInt("generation")==token)progress="PDF 正文：第 ${event.optInt("page")} / ${event.optInt("pages")} 页"
            "pdfSearchEnd"->{model.pdfSearchEvent(event);finished?.complete(Unit)}
            "pdfSearchHit"->model.pdfSearchEvent(event)
        }
    }.also {document=it}},onRelease={it.destroy()})}
    LaunchedEffect(token,query,bookIds) {
        ready.await()
        try {for(book in books) {
            ensureActive();finished=CompletableDeferred();progress="正在搜索 PDF《${book.text("title")}》"
            try {val source=model.repository.command("bookResource",JSONObject().put("id",book.id)).getString("path")
                document!!.javascript("searchPdf",document!!.resource(File(source)),book.id,query,token)
                finished!!.await()
            }catch(error:Exception){if(error is CancellationException)throw error;model.pdfSearchEvent(JSONObject().put("type","pdfSearchEnd").put("generation",token).put("bookId",book.id).put("error",error.message))}
        }}finally {progress=""}
    }
}

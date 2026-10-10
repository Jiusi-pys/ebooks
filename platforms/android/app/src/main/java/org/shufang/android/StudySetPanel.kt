package org.shufang.android

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable fun StudySetPanel(model:LibraryViewModel,state:LibraryState,onEdit:(String,Record)->Unit) {
    val set=state.records["studySets"].orEmpty().find {it.id==state.studySetId}?:return
    val array=set.value.optJSONArray("bookIds")
    val ids=if(array==null)emptySet()else (0 until array.length()).map {array.getString(it)}.toSet()
    val books=state.records["books"].orEmpty().filter {it.id in ids}
    val cards=state.records["highlights"].orEmpty().filter {it.text("bookId") in ids && it.value.optJSONObject("citation")?.optString("level","content")!="book" && it.value.optJSONObject("citation")?.optString("level","content")!="chapter"}
    val maps=state.records["mindMaps"].orEmpty().filter {it.text("bookId") in ids}
    val due=cards.count {it.value.optJSONObject("review")?.optLong("due")?.let {due->due<=System.currentTimeMillis()}==true}
    LazyColumn(Modifier.fillMaxSize().padding(16.dp)) {
        item {Text(set.text("name"),style=MaterialTheme.typography.headlineMedium);Text(set.text("description"));Text("${books.size} 本书 · ${cards.size} 张卡片 · ${maps.size} 幅脑图 · $due 张到期")
            Row {TextButton(onClick={onEdit("studySets",set)}){Text("编辑学习集")};TextButton(onClick={model.reviewQueue(set.id)}){Text("复习本集")};TextButton(onClick={model.navigate("search")}){Text("搜索")}}
            Text("书籍",style=MaterialTheme.typography.titleLarge)
        }
        items(books,key={"book:"+it.id}) {book->ListItem(headlineContent={Text(book.text("title"))},supportingContent={Text(book.text("author"))},modifier=Modifier.clickable {model.openBook(book.id)})}
        item {Text("脑图",style=MaterialTheme.typography.titleLarge)}
        items(maps,key={"mind:"+it.id}) {map->ListItem(headlineContent={Text(map.text("title"))},modifier=Modifier.clickable {onEdit("mindMaps",map)})}
        item {Text("最近卡片",style=MaterialTheme.typography.titleLarge)}
        items(cards.sortedByDescending {it.value.optLong("updatedAt")},key={"quote:"+it.id}) {card->ListItem(headlineContent={Text(card.text("text").take(160))},supportingContent={Text(card.text("chapterTitle"))},modifier=Modifier.clickable {model.openBook(card.text("bookId"),card.value)})}
    }
}

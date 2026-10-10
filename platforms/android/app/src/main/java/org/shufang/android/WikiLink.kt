package org.shufang.android

/** Web navigation resolves book titles before note titles, without case. */
fun wikiTarget(title:String,records:Map<String,List<Record>>):Pair<String,Record>? {
    val normalized=title.trim()
    for(kind in listOf("books","notes"))records[kind].orEmpty().find {it.text("title").equals(normalized,ignoreCase=true)}?.let {return kind to it}
    return null
}

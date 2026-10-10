package org.shufang.android

object AiContext {
    fun prefix(text:String,limit:Int):String {
        require(limit>=0)
        var end=minOf(text.length,limit)
        if(end<text.length && end>0 && text[end-1].isHighSurrogate())end--
        return text.substring(0,end)
    }
    fun chunks(text:String,limit:Int):List<String> {
        require(limit>=2)
        val result=mutableListOf<String>();var start=0
        while(start<text.length) {
            var end=minOf(start+limit,text.length)
            if(end<text.length && text[end-1].isHighSurrogate())end--
            result+=text.substring(start,end);start=end
        }
        return result
    }
}

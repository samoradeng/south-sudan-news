// Global state variables
let isLoadingNews = false;
let hasMoreNews = true;
let newsOffset = 0;
const count = 5; // Fetch 50 articles at a time
let allArticles = []; // Store all fetched articles

// API configuration
const apiUrl = 'https://bing-news-search1.p.rapidapi.com/news/search?q=south%20sudan&freshness=Week&textFormat=Raw&safeSearch=Off';
const options = {
    method: 'GET',
    headers: {
        'X-BingApis-SDK': 'true',
        'X-RapidAPI-Key': '474732235emsh86f1979632a9b64p1b7bb2jsn6632160040c3', // Replace with your actual API key
        'X-RapidAPI-Host': 'bing-news-search1.p.rapidapi.com'
    }
};

// Fetch and sort news articles
async function fetchNews(offset = 0) {
    if (!hasMoreNews || isLoadingNews) return;
    isLoadingNews = true;
    showLoadingIndicator();

    const paginatedUrl = `${apiUrl}&count=${count}&offset=${offset}`;
    try {
        const response = await fetch(paginatedUrl, options);
        const data = await response.json();
        console.log('Fetched articles:', data.value.length); // Log the number of articles fetched
        if (!data.value || data.value.length < count) hasMoreNews = false;
        if (data.value && data.value.length > 0) {
            // Combine with all fetched articles and sort
            allArticles = allArticles.concat(data.value)
                .sort((a, b) => new Date(b.datePublished) - new Date(a.datePublished));
            if (offset === 0) displayArticlesChunk(); // Only display the first chunk
        }
    } catch (error) {
        console.error('Error fetching news:', error);
    } finally {
        isLoadingNews = false;
        hideLoadingIndicator();
    }
}

// Show and hide loading indicator
function showLoadingIndicator() {
    let loadingIndicator = document.getElementById('loading-indicator');
    if (!loadingIndicator) {
        loadingIndicator = document.createElement('div');
        loadingIndicator.id = 'loading-indicator';
        loadingIndicator.innerText = 'Loading more news...';
        loadingIndicator.style.textAlign = 'center';
        loadingIndicator.style.padding = '10px';
        loadingIndicator.style.marginTop = '10px';
        document.body.appendChild(loadingIndicator);
    }
    loadingIndicator.style.display = 'block';
}

function hideLoadingIndicator() {
    const loadingIndicator = document.getElementById('loading-indicator');
    if (loadingIndicator) loadingIndicator.style.display = 'none';
}

function showToast(message) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = 'show';
    setTimeout(() => { toast.className = toast.className.replace('show', ''); }, 3000); // hide after 3 seconds
}

function scrollToTopAndReload() {
    window.scrollTo({ top: 0, behavior: 'smooth' });

    setTimeout(() => {
        location.reload();
    }, 700); // Adjust the timeout duration if needed
}


// Display a chunk of 10 articles
function displayArticlesChunk() {
    console.log('displayArticlesChunk called'); // Debugging line
    const container = document.getElementById('news-container');
    let articlesToDisplay = allArticles.splice(0, 30); // Get the next 10 articles to display
    articlesToDisplay.forEach((article, index) => {
        const articleElement = createArticleElement(article, index + newsOffset);
        container.appendChild(articleElement);
    });
    console.log('Number of articles after append:', container.children.length); // Debugging line
    newsOffset += articlesToDisplay.length; // Update the offset based on the number of articles displayed
}


// Create an article HTML element
function createArticleElement(article, index) {
    const isFeatured = index % 4 === 0;
    const elapsedTime = getTimeSince(article.datePublished);
    const articleClass = isFeatured ? 'article featured-article' : 'article';

    // Create an anchor element
    const articleLink = document.createElement('a');
    articleLink.href = article.url; // Set the URL to the article's link
    articleLink.target = "_blank"; // Open in a new tab
    articleLink.className = articleClass;

    // Set the innerHTML of the anchor element
    articleLink.innerHTML = `
        ${article.image?.thumbnail?.contentUrl ? `<img src="${article.image.thumbnail.contentUrl}" alt="" class="article-image">` : ''}
        <div class="article-content">
            <div class="article-header">
                <div class="article-logo" style="background-image: url('${article.provider[0]?.image?.thumbnail?.contentUrl || ''}');"></div>
                <div>
                    <div class="article-source">${article.provider[0]?.name}</div>
                    <div class="time-since">${elapsedTime}</div>
                </div>
            </div>
            <h2 class="article-title">${article.name}</h2>
            ${isFeatured ? `<p class="article-summary">${article.description || ''}</p>` : ''}
        </div>
    `;

    return articleLink; // Return the anchor element
}


function getTimeSince(publishedDate) {
    const datePublished = new Date(publishedDate);
    const now = new Date();
    const timeSince = now - datePublished;
    const minutes = Math.floor(timeSince / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days >= 1) {
        return `${days}d`;
    } else if (hours >= 1) {
        return `${hours}h`;
    } else {
        return `${minutes}m`;
    }
}

function displayArticleContent(article) {
    document.getElementById('news-container').style.display = 'none'; // Hide the news container
    const articlePage = document.createElement('div');
    articlePage.id = 'article-page';
    articlePage.innerHTML = `
      <h1>${article.name}</h1>
      <img src="${article.image?.thumbnail?.contentUrl || ''}" alt="" class="full-article-image">
      <p>${article.description}</p>
      <a href="${article.url}" target="_blank">Read full article</a>
    `;
    const backButton = document.createElement('a');
    backButton.id = 'back-button';
    backButton.textContent = 'Back';
    backButton.href = '#';
    backButton.addEventListener('click', function (e) {
        e.preventDefault();
        document.body.removeChild(articlePage);
        document.getElementById('news-container').style.display = 'block'; // Show the news container again
    });
    articlePage.prepend(backButton);
    document.body.appendChild(articlePage);
}

// Scroll event for infinite loading
window.addEventListener('scroll', () => {
    console.log('Scroll event triggered'); // Debugging line
    if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 500) {
        console.log('Near the bottom'); // Debugging line
        if (allArticles.length > 0) {
            displayArticlesChunk(); // Display the next chunk of articles
        } else if (!isLoadingNews && hasMoreNews) {
            console.log('Fetching more news'); // Debugging line
            //showToast('You have reached the end of the news feed. Scroll up to refresh.');
            fetchNews(newsOffset); // Fetch more news when we run out of preloaded articles
        } else {
            // New debugging lines
            console.log('isLoadingNews:', isLoadingNews);
            console.log('hasMoreNews:', hasMoreNews);
        }
    }
});


// Initial fetch of news
fetchNews(newsOffset);

// Add click event listener to refresh button
document.getElementById('refresh-news').addEventListener('click', () => {
    allArticles = []; // Clear the current articles
    newsOffset = 0; // Reset the offset
    hasMoreNews = true; // Reset the flag
    fetchNews(newsOffset); // Fetch the initial set of news
});